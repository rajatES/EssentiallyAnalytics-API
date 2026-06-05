import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, In } from 'typeorm';
import { TrafficDaily } from '../utm-analytics/entities/traffic-daily.entity';
import { PageMapping } from '../page-mappings/entities/page-mapping.entity';
import { DailyRevenue } from '../revenue/entities/daily-revenue.entity';
import { RevenueMapping } from '../revenue/entities/revenue-mapping.entity';
import { AnalyticsSnapshot } from '../facebook/entities/AnalyticsSnapshot.entity';
import { SocialProfile } from '../facebook/entities/SocialProfile.entity';
import { SocialPost } from '../facebook/entities/SocialPost.entity';

@Injectable()
export class CsvGeneratorService {
  private readonly logger = new Logger(CsvGeneratorService.name);

  constructor(
    @InjectRepository(TrafficDaily)
    private readonly utmRepo: Repository<TrafficDaily>,
    @InjectRepository(PageMapping)
    private readonly pageMappingRepo: Repository<PageMapping>,
    @InjectRepository(DailyRevenue)
    private readonly dailyRevenueRepo: Repository<DailyRevenue>,
    @InjectRepository(RevenueMapping)
    private readonly revenueMappingRepo: Repository<RevenueMapping>,
    @InjectRepository(AnalyticsSnapshot)
    private readonly snapshotRepo: Repository<AnalyticsSnapshot>,
    @InjectRepository(SocialProfile)
    private readonly profileRepo: Repository<SocialProfile>,
    @InjectRepository(SocialPost)
    private readonly postRepo: Repository<SocialPost>,
  ) {}

  async generateTrafficCSV(
    startDate: string,
    endDate: string,
  ): Promise<string> {
    this.logger.log(`Generating Traffic CSV for ${startDate} to ${endDate}`);

    const mappings = await this.pageMappingRepo.find();

    // Build the date column list. Newest date first (matches sample template).
    const dates = this.enumerateDates(startDate, endDate).reverse();
    const dateHeaders = dates.map((d) => this.fmtHumanDate(d));

    // Per-(medium, date) sessions
    const rows = await this.utmRepo
      .createQueryBuilder('a')
      .select([
        'a.utmMedium AS utm_medium',
        `to_char(a.date::date, 'YYYY-MM-DD') AS date`,
        'SUM(a.sessions) AS sessions',
      ])
      .where(
        `a.date::date >= :startDate::date AND a.date::date <= :endDate::date`,
        { startDate, endDate },
      )
      .andWhere(
        `(a.utmSource ILIKE '%face%' OR a.utmSource ILIKE '%ig%' OR a.utmSource ILIKE '%insta%' OR a.utmSource IN ('fb', 'Fb'))`,
      )
      .groupBy('a.utmMedium')
      .addGroupBy('a.date')
      .getRawMany();

    // Map UTM medium → { pageName, category, team, platform }
    const mediumToPage = new Map<
      string,
      { pageName: string; category: string; team: string; platform: string }
    >();
    for (const mapping of mappings) {
      for (const medium of mapping.utmMediums) {
        mediumToPage.set(medium.toLowerCase(), {
          pageName: mapping.pageName,
          category: mapping.category,
          team: mapping.team || 'Unassigned',
          platform: mapping.platform || 'FB',
        });
      }
    }

    // Aggregate by pageName × date (multiple mediums can resolve to the same page)
    type PageBucket = {
      pageName: string;
      category: string;
      team: string;
      platform: string;
      perDay: Map<string, number>;
    };
    const pageData = new Map<string, PageBucket>();

    for (const row of rows) {
      const medium = (row.utm_medium || '').toLowerCase();
      const info = mediumToPage.get(medium);
      const pageName = info?.pageName || row.utm_medium || 'Unknown';

      if (!pageData.has(pageName)) {
        pageData.set(pageName, {
          pageName,
          category: info?.category || 'Uncategorized',
          team: info?.team || 'Unassigned',
          platform: info?.platform || 'FB',
          perDay: new Map(),
        });
      }
      const entry = pageData.get(pageName)!;
      const dateStr = this.toDateStr(row.date);
      entry.perDay.set(
        dateStr,
        (entry.perDay.get(dateStr) || 0) + Number(row.sessions || 0),
      );
    }

    // Group pages → team → category
    const teamMap = new Map<string, Map<string, PageBucket[]>>();
    for (const [, page] of pageData) {
      if (!teamMap.has(page.team)) teamMap.set(page.team, new Map());
      const catMap = teamMap.get(page.team)!;
      if (!catMap.has(page.category)) catMap.set(page.category, []);
      catMap.get(page.category)!.push(page);
    }

    const csvRows: string[] = [];
    const blanks = (n: number) => Array(n).fill('');

    // ── Section 1: Team-wise daily totals ──
    csvRows.push(this.joinRow(['Team', ...dateHeaders]));
    const teamDailyTotals = new Map<string, number[]>();
    const grandDaily = new Array(dates.length).fill(0);
    for (const [team, catMap] of teamMap) {
      const totals = new Array(dates.length).fill(0);
      for (const [, pages] of catMap) {
        for (const page of pages) {
          dates.forEach((d, i) => {
            totals[i] += page.perDay.get(d) || 0;
          });
        }
      }
      teamDailyTotals.set(team, totals);
      totals.forEach((v, i) => {
        grandDaily[i] += v;
      });
      csvRows.push(this.joinRow([team, ...totals.map((n) => this.fmtInt(n))]));
    }
    csvRows.push(
      this.joinRow(['Total', ...grandDaily.map((n) => this.fmtInt(n))]),
    );

    // Blank separator
    csvRows.push('');

    // ── Section 2: Page-wise daily link clicks, grouped by team + category ──
    // Header matches template: `,Page Name,Platform,Daily Link Clicks,,,,,,`
    //                          `,,,<date1>,<date2>,...<date7>`
    csvRows.push(
      this.joinRow([
        '',
        'Page Name',
        'Platform',
        'Daily Link Clicks',
        ...blanks(dates.length - 1),
      ]),
    );
    csvRows.push(this.joinRow(['', '', '', ...dateHeaders]));

    for (const [team, catMap] of teamMap) {
      for (const [category, pages] of catMap) {
        // Category subtotal row: <Team>,<Category>,,<day totals>
        const catTotals = new Array(dates.length).fill(0);
        for (const page of pages) {
          dates.forEach((d, i) => {
            catTotals[i] += page.perDay.get(d) || 0;
          });
        }
        csvRows.push(
          this.joinRow([
            team,
            category,
            '',
            ...catTotals.map((n) => this.fmtInt(n)),
          ]),
        );

        // Individual page rows
        for (const page of pages) {
          const perDay = dates.map((d) => this.fmtInt(page.perDay.get(d) || 0));
          csvRows.push(
            this.joinRow(['', page.pageName, page.platform, ...perDay]),
          );
        }
      }
    }

    // TOTAL row — matches template: `,TOTAL,,<day totals>`
    csvRows.push(
      this.joinRow(['', 'TOTAL', '', ...grandDaily.map((n) => this.fmtInt(n))]),
    );

    return csvRows.join('\n');
  }

  async generateRevenueCSV(
    startDate: string,
    endDate: string,
  ): Promise<string> {
    this.logger.log(`Generating Revenue CSV for ${startDate} to ${endDate}`);

    const dates = this.enumerateDates(startDate, endDate);
    const dateHeaders = dates.map((d) => this.fmtHumanDate(d));

    const rows = await this.dailyRevenueRepo
      .createQueryBuilder('dr')
      .select([
        `to_char(dr.date, 'YYYY-MM-DD') AS "date"`,
        'rm.pageName AS "pageName"',
        'rm.team AS "team"',
        'dr.totalRevenue AS "total"',
      ])
      .innerJoin(RevenueMapping, 'rm', 'rm.pageId = dr.pageId')
      .where('dr.date >= :startDate', { startDate })
      .andWhere('dr.date <= :endDate', { endDate })
      .orderBy('"team"', 'ASC')
      .addOrderBy('"pageName"', 'ASC')
      .getRawMany();

    // Page mapping lookup for Division (category) by pageName
    const pageMappings = await this.pageMappingRepo.find();
    const divisionByName = new Map<string, string>();
    for (const m of pageMappings) {
      divisionByName.set(m.pageName.trim().toLowerCase(), m.category);
    }

    // Aggregate: team → perDay, pages → { team, division, perDay }
    const teamDaily = new Map<string, Map<string, number>>();
    const pageDaily = new Map<
      string,
      { team: string; perDay: Map<string, number> }
    >();

    for (const row of rows) {
      const team = row.team || 'Unassigned';
      const pageName = row.pageName || 'Unknown';
      const dateStr = this.toDateStr(row.date);
      const total = Number(row.total || 0);

      if (!teamDaily.has(team)) teamDaily.set(team, new Map());
      const td = teamDaily.get(team)!;
      td.set(dateStr, (td.get(dateStr) || 0) + total);

      if (!pageDaily.has(pageName))
        pageDaily.set(pageName, { team, perDay: new Map() });
      const pd = pageDaily.get(pageName)!;
      pd.perDay.set(dateStr, (pd.perDay.get(dateStr) || 0) + total);
    }

    const csvRows: string[] = [];

    // ── Section 1: Team-wise daily revenue totals ──
    // Drop teams with zero revenue across the range to match the page-level
    // filter (no point emitting an all-zeros row).
    csvRows.push(this.joinRow(['Team', ...dateHeaders]));
    const grandDaily = new Array(dates.length).fill(0);
    for (const [team, perDay] of teamDaily) {
      const values = dates.map((d) => Number(perDay.get(d) || 0));
      const rowSum = values.reduce((a, b) => a + b, 0);
      if (rowSum <= 0) continue;
      values.forEach((v, i) => {
        grandDaily[i] += v;
      });
      csvRows.push(
        this.joinRow([team, ...values.map((v) => this.fmtMoney(v))]),
      );
    }
    csvRows.push(
      this.joinRow(['Total', ...grandDaily.map((v) => this.fmtMoney(v))]),
    );

    // Blank separator
    csvRows.push('');

    // ── Section 2: Page-wise daily revenue with Division + Monetization ──
    // Only include pages whose total revenue across the range is non-zero —
    // pages that earned $0 in the period are dropped from the email CSV.
    csvRows.push(
      this.joinRow(['Pages', 'Division', 'Monetization', ...dateHeaders]),
    );
    const sortedPages = Array.from(pageDaily.entries())
      .filter(([, entry]) => {
        let sum = 0;
        for (const v of entry.perDay.values()) sum += Number(v) || 0;
        return sum > 0;
      })
      .sort((a, b) => {
        const ta = (a[1].team || '').localeCompare(b[1].team || '');
        return ta !== 0 ? ta : a[0].localeCompare(b[0]);
      });
    for (const [pageName, entry] of sortedPages) {
      const division = divisionByName.get(pageName.trim().toLowerCase()) || '';
      const monetization = ''; // Not tracked in DB yet — column present to match template
      const values = dates.map((d) =>
        this.fmtMoney(Number(entry.perDay.get(d) || 0)),
      );
      csvRows.push(this.joinRow([pageName, division, monetization, ...values]));
    }

    return csvRows.join('\n');
  }

  async generateMetaReportCSV(
    startDate: string,
    endDate: string,
  ): Promise<string> {
    this.logger.log(
      `Generating Meta Report CSV for ${startDate} to ${endDate}`,
    );

    const profiles = await this.profileRepo.find({ where: { isActive: true } });
    const profileIds = profiles.map((p) => p.profileId);

    if (profileIds.length === 0) {
      return 'Metric,Value,Change (%)\nNo active profiles found,,';
    }

    // Compute previous period for comparison
    const startD = new Date(`${startDate}T00:00:00.000Z`);
    const endD = new Date(`${endDate}T00:00:00.000Z`);
    const daysSpan =
      Math.round((endD.getTime() - startD.getTime()) / 86400000) + 1;
    const prevEnd = new Date(startD);
    prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
    const prevStart = new Date(prevEnd);
    prevStart.setUTCDate(prevStart.getUTCDate() - daysSpan + 1);

    const prevStartStr = prevStart.toISOString().split('T')[0];
    const prevEndStr = prevEnd.toISOString().split('T')[0];

    // Current period snapshots
    const currentSnapshots = await this.snapshotRepo.find({
      where: { profileId: In(profileIds), date: Between(startDate, endDate) },
    });

    const prevSnapshots = await this.snapshotRepo.find({
      where: {
        profileId: In(profileIds),
        date: Between(prevStartStr, prevEndStr),
      },
    });

    // Current period posts
    const currentPosts = await this.postRepo.find({
      where: {
        profileId: In(profileIds),
        postedAt: Between(
          new Date(`${startDate}T00:00:00.000+05:30`),
          new Date(`${endDate}T23:59:59.999+05:30`),
        ),
      },
    });

    const prevPosts = await this.postRepo.find({
      where: {
        profileId: In(profileIds),
        postedAt: Between(
          new Date(`${prevStartStr}T00:00:00.000+05:30`),
          new Date(`${prevEndStr}T23:59:59.999+05:30`),
        ),
      },
    });

    // Aggregate current period
    let currentFollowersGained = 0,
      currentUnfollows = 0,
      currentImpressions = 0;
    let currentEngagements = 0,
      currentPageViews = 0,
      currentMessages = 0;
    let currentVideoViews = 0,
      currentRevenue = 0;

    for (const snap of currentSnapshots) {
      currentFollowersGained += Number(snap.followersGained || 0);
      currentUnfollows += Number(snap.unfollows || 0);
      currentImpressions += Number(
        snap.totalImpressions || snap.totalReach || 0,
      );
      currentEngagements += Number(snap.totalEngagement || 0);
      currentPageViews += Number(snap.pageViews || 0);
      currentMessages += Number(snap.netMessages || 0);
      currentRevenue += Number(snap.revenue || 0);
      if (snap.platform === 'facebook') {
        currentVideoViews += Number(snap.videoViews || 0);
      }
    }

    for (const post of currentPosts) {
      const postEng =
        Number(post.likes || 0) +
        Number(post.comments || 0) +
        Number(post.shares || 0) +
        Number(post.clicks || 0);
      currentEngagements += postEng;
      if (post.platform === 'instagram') {
        currentVideoViews += Number(post.views || 0);
        currentImpressions += Number(post.views || 0) + Number(post.reach || 0);
      } else if (post.platform === 'facebook') {
        currentImpressions += Number(post.reach || 0);
      }
    }

    const currentNetGrowth = currentFollowersGained - currentUnfollows;
    const currentEngRate =
      currentImpressions > 0
        ? (currentEngagements / currentImpressions) * 100
        : 0;

    // Aggregate previous period
    let prevFollowersGained = 0,
      prevUnfollows = 0,
      prevImpressions = 0;
    let prevEngagements = 0,
      prevPageViews = 0,
      prevMessages = 0;
    let prevVideoViews = 0,
      prevRevenue = 0;

    for (const snap of prevSnapshots) {
      prevFollowersGained += Number(snap.followersGained || 0);
      prevUnfollows += Number(snap.unfollows || 0);
      prevImpressions += Number(snap.totalImpressions || snap.totalReach || 0);
      prevEngagements += Number(snap.totalEngagement || 0);
      prevPageViews += Number(snap.pageViews || 0);
      prevMessages += Number(snap.netMessages || 0);
      prevRevenue += Number(snap.revenue || 0);
      if (snap.platform === 'facebook') {
        prevVideoViews += Number(snap.videoViews || 0);
      }
    }

    for (const post of prevPosts) {
      prevEngagements +=
        Number(post.likes || 0) +
        Number(post.comments || 0) +
        Number(post.shares || 0) +
        Number(post.clicks || 0);
      if (post.platform === 'instagram') {
        prevVideoViews += Number(post.views || 0);
        prevImpressions += Number(post.views || 0) + Number(post.reach || 0);
      } else if (post.platform === 'facebook') {
        prevImpressions += Number(post.reach || 0);
      }
    }

    const prevNetGrowth = prevFollowersGained - prevUnfollows;
    const prevEngRate =
      prevImpressions > 0 ? (prevEngagements / prevImpressions) * 100 : 0;

    // Get current total audience
    let currentAudience = 0;
    for (const pid of profileIds) {
      const latest = await this.snapshotRepo.findOne({
        where: { profileId: pid },
        order: { date: 'DESC' },
      });
      if (latest && latest.totalFollowers > 0)
        currentAudience += latest.totalFollowers;
    }
    const prevAudience = currentAudience - currentNetGrowth;

    const calcChange = (cur: number, prev: number): string => {
      if (prev === 0) return cur > 0 ? '+100.0%' : cur < 0 ? '-100.0%' : '0.0%';
      const pct = ((cur - prev) / Math.abs(prev)) * 100;
      return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
    };

    const csvRows: string[] = [
      'Metric,Value,Change (%)',
      `Total Audience,${currentAudience.toLocaleString()},${calcChange(currentAudience, prevAudience)}`,
      `Net Followers,${currentNetGrowth >= 0 ? '+' : ''}${currentNetGrowth.toLocaleString()},${calcChange(currentNetGrowth, prevNetGrowth)}`,
      `Impressions,${currentImpressions.toLocaleString()},${calcChange(currentImpressions, prevImpressions)}`,
      `Engagements,${currentEngagements.toLocaleString()},${calcChange(currentEngagements, prevEngagements)}`,
      `Engagement Rate,${currentEngRate.toFixed(1)}%,${calcChange(currentEngRate, prevEngRate)}`,
      `Page Views,${currentPageViews.toLocaleString()},${calcChange(currentPageViews, prevPageViews)}`,
      `Video Views,${currentVideoViews.toLocaleString()},${calcChange(currentVideoViews, prevVideoViews)}`,
      `Messages,${currentMessages.toLocaleString()},${calcChange(currentMessages, prevMessages)}`,
      `Revenue,$${currentRevenue.toFixed(2)},${calcChange(currentRevenue, prevRevenue)}`,
    ];

    // ── Revenue by Team section ──
    const currentTeamRevenue = await this.dailyRevenueRepo
      .createQueryBuilder('dr')
      .select(['rm.team AS "team"', 'SUM(dr.totalRevenue) AS "total"'])
      .innerJoin(RevenueMapping, 'rm', 'rm.pageId = dr.pageId')
      .where('dr.date >= :startDate', { startDate })
      .andWhere('dr.date <= :endDate', { endDate })
      .groupBy('rm.team')
      .orderBy('"team"', 'ASC')
      .getRawMany();

    const prevTeamRevenue = await this.dailyRevenueRepo
      .createQueryBuilder('dr')
      .select(['rm.team AS "team"', 'SUM(dr.totalRevenue) AS "total"'])
      .innerJoin(RevenueMapping, 'rm', 'rm.pageId = dr.pageId')
      .where('dr.date >= :startDate', { startDate: prevStartStr })
      .andWhere('dr.date <= :endDate', { endDate: prevEndStr })
      .groupBy('rm.team')
      .orderBy('"team"', 'ASC')
      .getRawMany();

    const prevTeamMap = new Map<string, number>();
    for (const row of prevTeamRevenue) {
      prevTeamMap.set(row.team || 'Unassigned', Number(row.total || 0));
    }

    csvRows.push('');
    csvRows.push('Revenue by Team,Value,Change (%)');

    for (const row of currentTeamRevenue) {
      const team = row.team || 'Unassigned';
      const curTotal = Number(row.total || 0);
      const prevTotal = prevTeamMap.get(team) || 0;
      csvRows.push(
        `${this.escapeCSV(team)},$${curTotal.toFixed(2)},${calcChange(curTotal, prevTotal)}`,
      );
    }

    return csvRows.join('\n');
  }

  private escapeCSV(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  private fmtMoney(value: any): string {
    return `$${Number(value || 0).toFixed(2)}`;
  }

  private fmtInt(n: number): string {
    return Math.round(Number(n) || 0).toLocaleString('en-US');
  }

  /** Build inclusive date list (YYYY-MM-DD) from start→end. */
  private enumerateDates(startDate: string, endDate: string): string[] {
    const out: string[] = [];
    const start = new Date(startDate + 'T00:00:00Z');
    const end = new Date(endDate + 'T00:00:00Z');
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      out.push(d.toISOString().split('T')[0]);
    }
    return out;
  }

  /** Normalise any date-like value to YYYY-MM-DD. */
  private toDateStr(raw: any): string {
    if (!raw) return '';
    if (typeof raw === 'string') return raw.split('T')[0];
    return new Date(raw).toISOString().split('T')[0];
  }

  /** `2026-04-08` → `8 Apr 2026` (matches the sample template header). */
  private fmtHumanDate(iso: string): string {
    const d = new Date(iso + 'T00:00:00Z');
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }

  /** CSV-escape each cell and join with commas. */
  private joinRow(cols: (string | number)[]): string {
    return cols.map((c) => this.escapeCSV(String(c ?? ''))).join(',');
  }
}
