import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';

import { AnalyticsSnapshot } from '../facebook/entities/AnalyticsSnapshot.entity';
import { SocialPost } from '../facebook/entities/SocialPost.entity';
import { SocialProfile } from '../facebook/entities/SocialProfile.entity';
import { ReportSportsMapping } from '../report-sports-mappings/entities/report-sports-mapping.entity';
import { PageMapping } from '../page-mappings/entities/page-mapping.entity';
import { PagePathMapping } from '../page-mappings/entities/page-path-mapping.entity';
import { TrafficDaily } from '../utm-analytics/entities/traffic-daily.entity';
import { TrafficPageDaily } from '../utm-analytics/entities/traffic-page-daily.entity';

import {
  TRAFFIC_PLATFORMS,
  TrafficPlatformDef,
  buildPlatformSourceFilter,
  getTrafficPlatform,
} from '../../common/traffic-platforms';
import {
  compilePathMappings,
  matchPagePath,
} from '../../common/page-path-match';

/** Days in a full week. A week returning fewer is flagged, never silently scored. */
const FULL_WEEK_DAYS = 7;

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export interface RiskEnvelope<T> {
  dataset: string;
  grain: string[];
  week_ending: string;
  weeks: number;
  window_start: string;
  retrieved_at: string;
  row_count: number;
  notes?: string[];
  rows: T[];
}

@Injectable()
export class RiskService {
  constructor(
    @InjectRepository(AnalyticsSnapshot)
    private readonly snapshotRepo: Repository<AnalyticsSnapshot>,
    @InjectRepository(SocialPost)
    private readonly postRepo: Repository<SocialPost>,
    @InjectRepository(SocialProfile)
    private readonly profileRepo: Repository<SocialProfile>,
    @InjectRepository(ReportSportsMapping)
    private readonly sportsRepo: Repository<ReportSportsMapping>,
    @InjectRepository(PageMapping)
    private readonly pageMappingRepo: Repository<PageMapping>,
    @InjectRepository(PagePathMapping)
    private readonly pathMappingRepo: Repository<PagePathMapping>,
    @InjectRepository(TrafficDaily)
    private readonly trafficRepo: Repository<TrafficDaily>,
    @InjectRepository(TrafficPageDaily)
    private readonly trafficPageRepo: Repository<TrafficPageDaily>,
  ) {}

  // ---------------------------------------------------------------------------
  // Window handling
  // ---------------------------------------------------------------------------

  /**
   * Resolve the request window to an inclusive [start, end] pair of ISO dates.
   *
   * `week_ending` must be a Sunday. This is enforced rather than rounded: the
   * consumer buckets Monday-to-Sunday, and a window anchored on any other
   * weekday would return weeks that look complete while being offset from every
   * figure the routine compares them against. Failing loudly here is cheaper
   * than an off-by-one that only surfaces as an unexplained decline.
   */
  private resolveWindow(weekEnding: string, weeks: number) {
    const end = new Date(`${weekEnding}T00:00:00Z`);
    if (Number.isNaN(end.getTime())) {
      throw new BadRequestException(
        `week_ending is not a valid date: ${weekEnding}`,
      );
    }
    if (end.getUTCDay() !== 0) {
      throw new BadRequestException(
        `week_ending must be a Sunday; ${weekEnding} is a ${DAY_NAMES[end.getUTCDay()]}. ` +
          `The routine buckets Monday-to-Sunday.`,
      );
    }

    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - (weeks * FULL_WEEK_DAYS - 1));

    return {
      start: start.toISOString().slice(0, 10),
      end: weekEnding,
    };
  }

  /** Postgres expression bucketing a date/timestamp column to its week-ending Sunday. */
  private weekEndingExpr(column: string): string {
    return `(date_trunc('week', ${column})::date + 6)`;
  }

  private envelope<T>(
    dataset: string,
    grain: string[],
    weekEnding: string,
    weeks: number,
    windowStart: string,
    rows: T[],
    notes?: string[],
  ): RiskEnvelope<T> {
    return {
      dataset,
      grain,
      week_ending: weekEnding,
      weeks,
      window_start: windowStart,
      retrieved_at: new Date().toISOString(),
      row_count: rows.length,
      ...(notes && notes.length ? { notes } : {}),
      rows,
    };
  }

  private num(value: any): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * OR-group matching every source spelling for one platform, or for all of
   * them when none is named.
   *
   * Built from the shared registry rather than a second list, so the risk feed
   * can never drift from what the traffic dashboard shows.
   */
  private applyPlatformFilter(
    qb: SelectQueryBuilder<any>,
    alias: string,
    platform?: TrafficPlatformDef,
  ) {
    const targets = platform ? [platform] : TRAFFIC_PLATFORMS;
    const clauses: string[] = [];
    const params: Record<string, any> = {};

    targets.forEach((def) => {
      const built = buildPlatformSourceFilter(
        def,
        alias,
        'utmSource',
        `plat_${def.key}`,
      );
      clauses.push(built.sql);
      Object.assign(params, built.params);
    });

    qb.andWhere(`(${clauses.join(' OR ')})`, params);
  }

  /**
   * Same rules as the SQL filter, applied to one value.
   *
   * Kept alongside rather than duplicated: both read the shared registry, so a
   * new source spelling is added in one place and both paths pick it up.
   */
  private resolvePlatformKey(source: string): string | null {
    const lower = (source || '').trim().toLowerCase();
    for (const def of TRAFFIC_PLATFORMS) {
      if (def.exact.includes(lower)) return def.key;
      if (def.domains.some((d) => lower === d || lower.endsWith(`.${d}`))) {
        return def.key;
      }
      if (def.prefixes.some((p) => lower.startsWith(p))) return def.key;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // 1. Social engagement - platform-side reach and engagement per page per week
  // ---------------------------------------------------------------------------

  /**
   * Week-grain page insights, joined to the page's sport.
   *
   * Reach and impressions are summed across days. That is a sum of daily unique
   * reach, not weekly unique reach, which Meta does not expose per week. The
   * column names say `_sum` so nobody downstream reads them as a unique count.
   * Week-on-week comparison is unaffected because the bias is constant.
   *
   * Followers are taken from the last day present in the week rather than MAX,
   * so a week in which followers fell reports the fall.
   */
  async socialEngagement(weekEnding: string, weeks: number) {
    const { start, end } = this.resolveWindow(weekEnding, weeks);
    const week = this.weekEndingExpr('s.date');

    const rows = await this.snapshotRepo
      .createQueryBuilder('s')
      .leftJoin(SocialProfile, 'p', 'p."profileId" = s."profileId"')
      .leftJoin(ReportSportsMapping, 'm', 'm."profileId" = s."profileId"')
      .select(`TO_CHAR(${week}, 'YYYY-MM-DD')`, 'week_ending')
      .addSelect('s."profileId"', 'profile_id')
      .addSelect('MAX(p.name)', 'page_name')
      .addSelect('MAX(s.platform)', 'platform')
      .addSelect('MAX(m.sport)', 'sport')
      .addSelect('COUNT(*)::int', 'days_present')
      .addSelect(
        '(array_agg(s."totalFollowers" ORDER BY s.date DESC))[1]',
        'followers_end',
      )
      .addSelect('SUM(s."followersGained")', 'followers_gained')
      .addSelect('SUM(s.unfollows)', 'unfollows')
      .addSelect('SUM(s."totalReach")', 'reach_sum')
      .addSelect('SUM(s."totalImpressions")', 'impressions_sum')
      .addSelect('SUM(s."videoViews")', 'video_views')
      .addSelect('SUM(s."totalEngagement")', 'engagement')
      .addSelect('SUM(s."profileClicks")', 'profile_clicks')
      .addSelect('SUM(s."pageViews")', 'page_views')
      .addSelect('SUM(s."netMessages")', 'net_messages')
      .where('s.date >= :start AND s.date <= :end', { start, end })
      .groupBy(week)
      .addGroupBy('s."profileId"')
      .orderBy('week_ending', 'ASC')
      .addOrderBy('s."profileId"', 'ASC')
      .getRawMany();

    const mapped = rows.map((r) => ({
      week_ending: r.week_ending,
      profile_id: r.profile_id,
      page_name: r.page_name ?? null,
      platform: r.platform ?? null,
      sport: r.sport ?? null,
      days_present: this.num(r.days_present),
      partial_week: this.num(r.days_present) < FULL_WEEK_DAYS,
      followers_end: this.num(r.followers_end),
      followers_gained: this.num(r.followers_gained),
      unfollows: this.num(r.unfollows),
      reach_sum: this.num(r.reach_sum),
      impressions_sum: this.num(r.impressions_sum),
      video_views: this.num(r.video_views),
      engagement: this.num(r.engagement),
      profile_clicks: this.num(r.profile_clicks),
      page_views: this.num(r.page_views),
      net_messages: this.num(r.net_messages),
    }));

    return this.envelope(
      'social_engagement',
      ['week_ending', 'profile_id'],
      weekEnding,
      weeks,
      start,
      mapped,
      [
        'reach_sum and impressions_sum are sums of daily values, not weekly unique counts.',
        'Rows with partial_week=true cover fewer than 7 days and must not be scored as a decline.',
      ],
    );
  }

  // ---------------------------------------------------------------------------
  // 2. Social posts - weekly output plus the individual posts behind a spike
  // ---------------------------------------------------------------------------

  /**
   * Two shapes in one response: per-week totals per page, and the top posts of
   * the report week.
   *
   * The individual posts exist so an engagement spike can be named rather than
   * averaged away. Comment counts are returned; comment text is not held by
   * this service, so the consumer's sentiment panel stays unscored.
   */
  async socialPosts(weekEnding: string, weeks: number, top: number) {
    const { start, end } = this.resolveWindow(weekEnding, weeks);
    const week = this.weekEndingExpr('sp."postedAt"');

    const weekly = await this.postRepo
      .createQueryBuilder('sp')
      .leftJoin(SocialProfile, 'p', 'p."profileId" = sp."profileId"')
      .leftJoin(ReportSportsMapping, 'm', 'm."profileId" = sp."profileId"')
      .select(`TO_CHAR(${week}, 'YYYY-MM-DD')`, 'week_ending')
      .addSelect('sp."profileId"', 'profile_id')
      .addSelect('MAX(p.name)', 'page_name')
      .addSelect('MAX(sp.platform)', 'platform')
      .addSelect('MAX(m.sport)', 'sport')
      .addSelect('COUNT(*)::int', 'posts_published')
      .addSelect('SUM(sp.likes)', 'likes')
      .addSelect('SUM(sp.comments)', 'comments')
      .addSelect('SUM(sp.shares)', 'shares')
      .addSelect('SUM(sp.reach)', 'reach_sum')
      .addSelect('SUM(sp.views)', 'views')
      .addSelect('SUM(sp.clicks)', 'clicks')
      .where('sp."postedAt" >= :start AND sp."postedAt" < (:end::date + 1)', {
        start,
        end,
      })
      .andWhere('sp."isPublished" = true')
      .groupBy(week)
      .addGroupBy('sp."profileId"')
      .orderBy('week_ending', 'ASC')
      .addOrderBy('sp."profileId"', 'ASC')
      .getRawMany();

    const weeklyRows = weekly.map((r) => ({
      week_ending: r.week_ending,
      profile_id: r.profile_id,
      page_name: r.page_name ?? null,
      platform: r.platform ?? null,
      sport: r.sport ?? null,
      posts_published: this.num(r.posts_published),
      likes: this.num(r.likes),
      comments: this.num(r.comments),
      shares: this.num(r.shares),
      reach_sum: this.num(r.reach_sum),
      views: this.num(r.views),
      clicks: this.num(r.clicks),
    }));

    let topPosts: any[] = [];
    if (top > 0) {
      const reportWeekStart = new Date(`${end}T00:00:00Z`);
      reportWeekStart.setUTCDate(reportWeekStart.getUTCDate() - 6);

      const raw = await this.postRepo
        .createQueryBuilder('sp')
        .leftJoin(SocialProfile, 'p', 'p."profileId" = sp."profileId"')
        .select('sp."postId"', 'post_id')
        .addSelect('sp."profileId"', 'profile_id')
        .addSelect('p.name', 'page_name')
        .addSelect('sp.platform', 'platform')
        .addSelect('sp.permalink', 'permalink')
        .addSelect('sp."postType"', 'post_type')
        .addSelect(
          `TO_CHAR(sp."postedAt", 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
          'posted_at',
        )
        .addSelect('sp.likes', 'likes')
        .addSelect('sp.comments', 'comments')
        .addSelect('sp.shares', 'shares')
        .addSelect('sp.reach', 'reach')
        .addSelect('sp.views', 'views')
        .addSelect('sp.clicks', 'clicks')
        .addSelect('(sp.likes + sp.comments + sp.shares)', 'interactions')
        .where('sp."postedAt" >= :ws AND sp."postedAt" < (:end::date + 1)', {
          ws: reportWeekStart.toISOString().slice(0, 10),
          end,
        })
        .andWhere('sp."isPublished" = true')
        .orderBy('interactions', 'DESC')
        .limit(top)
        .getRawMany();

      topPosts = raw.map((r) => ({
        post_id: r.post_id,
        profile_id: r.profile_id,
        page_name: r.page_name ?? null,
        platform: r.platform ?? null,
        permalink: r.permalink ?? null,
        post_type: r.post_type ?? null,
        posted_at: r.posted_at,
        likes: this.num(r.likes),
        comments: this.num(r.comments),
        shares: this.num(r.shares),
        reach: this.num(r.reach),
        views: this.num(r.views),
        clicks: this.num(r.clicks),
        interactions: this.num(r.interactions),
      }));
    }

    return {
      ...this.envelope(
        'social_posts',
        ['week_ending', 'profile_id'],
        weekEnding,
        weeks,
        start,
        weeklyRows,
        [
          'Comment counts only. No comment text or sentiment is available from this source.',
          'top_posts covers the report week alone, ranked by likes + comments + shares.',
        ],
      ),
      top_posts: topPosts,
    };
  }

  // ---------------------------------------------------------------------------
  // 3. Social referral - UTM-tagged sessions arriving on the main site
  // ---------------------------------------------------------------------------

  /**
   * Week-grain sessions by source, medium and campaign, restricted to sources
   * that resolve to a known platform.
   *
   * The platform is resolved in TypeScript through the shared registry rather
   * than a SQL CASE, so there is exactly one implementation of the matching
   * rules. A second one would drift from the first.
   */
  async socialReferral(
    weekEnding: string,
    weeks: number,
    platformKey?: string,
  ) {
    const { start, end } = this.resolveWindow(weekEnding, weeks);
    const week = this.weekEndingExpr('t.date');

    let platform: TrafficPlatformDef | undefined;
    if (platformKey) {
      platform = getTrafficPlatform(platformKey);
      if (!platform) {
        throw new BadRequestException(`Unknown platform: ${platformKey}`);
      }
    }

    const qb = this.trafficRepo
      .createQueryBuilder('t')
      .select(`TO_CHAR(${week}, 'YYYY-MM-DD')`, 'week_ending')
      .addSelect('t."utmSource"', 'utm_source')
      .addSelect('t."utmMedium"', 'utm_medium')
      .addSelect('t."utmCampaign"', 'utm_campaign')
      .addSelect('COUNT(DISTINCT t.date)::int', 'days_present')
      .addSelect('SUM(t.sessions)', 'sessions')
      .addSelect('SUM(t.pageviews)', 'pageviews')
      .addSelect('SUM(t.users)', 'users')
      .addSelect('SUM(t."newUsers")', 'new_users')
      .addSelect('SUM(t."recurringUsers")', 'recurring_users')
      .addSelect('SUM(t."eventCount")', 'event_count')
      .where('t.date >= :start AND t.date <= :end', { start, end });

    this.applyPlatformFilter(qb, 't', platform);

    const rows = await qb
      .groupBy(week)
      .addGroupBy('t."utmSource"')
      .addGroupBy('t."utmMedium"')
      .addGroupBy('t."utmCampaign"')
      .orderBy('week_ending', 'ASC')
      .addOrderBy('sessions', 'DESC')
      .getRawMany();

    const mapped = rows.map((r) => ({
      week_ending: r.week_ending,
      platform: this.resolvePlatformKey(r.utm_source),
      utm_source: r.utm_source,
      utm_medium: r.utm_medium,
      utm_campaign: r.utm_campaign,
      days_present: this.num(r.days_present),
      partial_week: this.num(r.days_present) < FULL_WEEK_DAYS,
      sessions: this.num(r.sessions),
      pageviews: this.num(r.pageviews),
      users: this.num(r.users),
      new_users: this.num(r.new_users),
      recurring_users: this.num(r.recurring_users),
      event_count: this.num(r.event_count),
    }));

    return this.envelope(
      'social_referral',
      ['week_ending', 'utm_source', 'utm_medium', 'utm_campaign'],
      weekEnding,
      weeks,
      start,
      mapped,
      [
        'Restricted to utm_source values resolving to a known platform (fb, threads, reddit).',
        'Newsletter traffic also arrives with medium=referral, so channel assignment must key on source, never medium.',
      ],
    );
  }

  // ---------------------------------------------------------------------------
  // 4. Landing referral - untagged traffic, resolved by landing page
  // ---------------------------------------------------------------------------

  /**
   * Sessions grouped by the article they landed on, then resolved through the
   * URL-pattern mappings.
   *
   * This exists because most organic community referral carries no usable UTM
   * medium - the whole channel collapses into one row keyed on 'referral'. The
   * landing page is the only dimension that separates it.
   *
   * Paths matching no pattern still contribute to the totals, and the largest
   * of them are returned under `exceptions`, so a growing unmapped pile is
   * visible rather than quietly shrinking every mapped unit.
   */
  async landingReferral(
    weekEnding: string,
    weeks: number,
    platformKey?: string,
  ) {
    const { start, end } = this.resolveWindow(weekEnding, weeks);
    const week = this.weekEndingExpr('tp.date');

    let platform: TrafficPlatformDef | undefined;
    if (platformKey) {
      platform = getTrafficPlatform(platformKey);
      if (!platform) {
        throw new BadRequestException(`Unknown platform: ${platformKey}`);
      }
    }

    const qb = this.trafficPageRepo
      .createQueryBuilder('tp')
      .select(`TO_CHAR(${week}, 'YYYY-MM-DD')`, 'week_ending')
      .addSelect('tp."utmSource"', 'utm_source')
      .addSelect('tp."pagePath"', 'page_path')
      .addSelect('SUM(tp.sessions)', 'sessions')
      .addSelect('SUM(tp.pageviews)', 'pageviews')
      .addSelect('SUM(tp.users)', 'users')
      .where('tp.date >= :start AND tp.date <= :end', { start, end });

    this.applyPlatformFilter(qb, 'tp', platform);

    const raw = await qb
      .groupBy(week)
      .addGroupBy('tp."utmSource"')
      .addGroupBy('tp."pagePath"')
      .getRawMany();

    const compiled = compilePathMappings(await this.pathMappingRepo.find());

    const buckets = new Map<string, any>();
    const unmapped = new Map<string, any>();

    for (const r of raw) {
      const resolvedPlatform = this.resolvePlatformKey(r.utm_source);
      const match = matchPagePath(r.page_path, compiled);
      const pageName = match?.pageName ?? null;

      const key = [
        r.week_ending,
        resolvedPlatform ?? 'unknown',
        pageName ?? '__unmapped__',
      ].join(' ');

      const existing = buckets.get(key) ?? {
        week_ending: r.week_ending,
        platform: resolvedPlatform,
        page_name: pageName,
        category: match?.category ?? null,
        team: match?.team ?? null,
        mapped: Boolean(match),
        sessions: 0,
        pageviews: 0,
        users: 0,
        distinct_paths: 0,
      };

      existing.sessions += this.num(r.sessions);
      existing.pageviews += this.num(r.pageviews);
      existing.users += this.num(r.users);
      existing.distinct_paths += 1;
      buckets.set(key, existing);

      if (!match) {
        const uKey = [r.week_ending, r.page_path].join(' ');
        const u = unmapped.get(uKey) ?? {
          week_ending: r.week_ending,
          page_path: r.page_path,
          sessions: 0,
          pageviews: 0,
        };
        u.sessions += this.num(r.sessions);
        u.pageviews += this.num(r.pageviews);
        unmapped.set(uKey, u);
      }
    }

    const rows = Array.from(buckets.values()).sort((a, b) => {
      if (a.week_ending !== b.week_ending) {
        return a.week_ending < b.week_ending ? -1 : 1;
      }
      return b.sessions - a.sessions;
    });

    const unmappedRows = Array.from(unmapped.values());
    const unmappedSessions = unmappedRows.reduce(
      (sum, u) => sum + u.sessions,
      0,
    );
    const totalSessions = rows.reduce((sum, r) => sum + r.sessions, 0);

    return {
      ...this.envelope(
        'landing_referral',
        ['week_ending', 'platform', 'page_name'],
        weekEnding,
        weeks,
        start,
        rows,
        [
          'Landing-page resolution via page_path_mappings globs. Unmatched paths carry page_name=null and mapped=false.',
          'traffic_page_daily stores only sources belonging to a known platform, so this is not a whole-site denominator.',
        ],
      ),
      exceptions: {
        unmapped_sessions: unmappedSessions,
        unmapped_share:
          totalSessions > 0
            ? Number((unmappedSessions / totalSessions).toFixed(6))
            : 0,
        distinct_unmapped_paths: unmapped.size,
        top_unmapped: unmappedRows
          .sort((a, b) => b.sessions - a.sessions)
          .slice(0, 50),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // 5. Mappings - the taxonomies the consumer reconciles against
  // ---------------------------------------------------------------------------

  /**
   * The mapping tables, returned whole.
   *
   * The consumer keeps its own channel and unit registry. Serving these lets it
   * reconcile against the maintained source instead of holding a second copy
   * that drifts - the divergence then becomes a reported finding rather than a
   * silent one.
   */
  async mappings() {
    const [pageMappings, pathMappings, sportsMappings, profiles] =
      await Promise.all([
        this.pageMappingRepo.find({
          order: { platform: 'ASC', pageName: 'ASC' },
        }),
        this.pathMappingRepo.find({
          order: { priority: 'DESC', pattern: 'ASC' },
        }),
        this.sportsRepo.find({ order: { sport: 'ASC', pageName: 'ASC' } }),
        this.profileRepo.find({ order: { platform: 'ASC', name: 'ASC' } }),
      ]);

    return {
      dataset: 'mappings',
      retrieved_at: new Date().toISOString(),
      platforms: TRAFFIC_PLATFORMS.map((p) => ({
        key: p.key,
        label: p.label,
        exact: p.exact,
        domains: p.domains,
        prefixes: p.prefixes,
      })),
      page_mappings: pageMappings.map((m) => ({
        id: m.id,
        category: m.category,
        team: m.team,
        platform: m.platform,
        page_name: m.pageName,
        utm_source: m.utmSource,
        utm_mediums: m.utmMediums,
      })),
      page_path_mappings: pathMappings.map((m) => ({
        id: m.id,
        pattern: m.pattern,
        page_name: m.pageName,
        category: m.category,
        team: m.team,
        priority: m.priority,
      })),
      report_sports_mappings: sportsMappings.map((m) => ({
        id: m.id,
        profile_id: m.profileId,
        page_name: m.pageName,
        sport: m.sport,
      })),
      profiles: profiles.map((p) => ({
        profile_id: p.profileId,
        name: p.name,
        platform: p.platform,
        is_active: p.isActive,
        sync_state: p.syncState,
        last_sync_error: p.lastSyncError ?? null,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // 6. Coverage - what the consumer must not mistake for a clean result
  // ---------------------------------------------------------------------------

  /**
   * Earliest and latest date held by each dataset, plus profile sync state.
   *
   * The consumer needs this to decide whether a baseline exists at all. Social
   * history here is far shorter than the main lake's, so a year-on-year
   * comparison is unavailable and has to be flagged low-confidence rather than
   * computed against nothing. A stale source must read as failed, never as zero.
   */
  async coverage() {
    const range = async (
      repo: Repository<any>,
      alias: string,
      column: string,
    ) => {
      const row = await repo
        .createQueryBuilder(alias)
        .select(`TO_CHAR(MIN(${alias}.${column}), 'YYYY-MM-DD')`, 'first')
        .addSelect(`TO_CHAR(MAX(${alias}.${column}), 'YYYY-MM-DD')`, 'last')
        .addSelect('COUNT(*)::int', 'rows')
        .getRawOne();
      return {
        first_date: row?.first ?? null,
        last_date: row?.last ?? null,
        row_count: this.num(row?.rows),
      };
    };

    const [snapshots, posts, traffic, trafficPage, profiles] =
      await Promise.all([
        range(this.snapshotRepo, 's', 'date'),
        range(this.postRepo, 'sp', '"postedAt"'),
        range(this.trafficRepo, 't', 'date'),
        range(this.trafficPageRepo, 'tp', 'date'),
        this.profileRepo.find(),
      ]);

    return {
      dataset: 'coverage',
      retrieved_at: new Date().toISOString(),
      sources: {
        analytics_snapshots: snapshots,
        social_posts: posts,
        traffic_daily: traffic,
        traffic_page_daily: trafficPage,
      },
      profiles: {
        total: profiles.length,
        active: profiles.filter((p) => p.isActive).length,
        failing: profiles
          .filter((p) => p.lastSyncError)
          .map((p) => ({
            profile_id: p.profileId,
            name: p.name,
            sync_state: p.syncState,
            last_sync_error: p.lastSyncError,
          })),
      },
      notes: [
        'A source whose last_date is behind the report week is stale, not zero. Score it as a failed source.',
        'Social history is shorter than 52 weeks, so year-on-year baselines are unavailable for these units.',
      ],
    };
  }
}
