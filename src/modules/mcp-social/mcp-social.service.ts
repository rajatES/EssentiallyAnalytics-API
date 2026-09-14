import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { format, parseISO, subDays } from 'date-fns';

import {
  TRAFFIC_PLATFORMS,
  buildSocialSourceFilter,
  getTrafficPlatform,
  platformForSource,
  type TrafficPlatformDef,
} from '../../common/traffic-platforms';
import {
  compilePathMappings,
  matchPagePath,
} from '../../common/page-path-match';
import { TrafficDaily } from '../utm-analytics/entities/traffic-daily.entity';
import { TrafficPageDaily } from '../utm-analytics/entities/traffic-page-daily.entity';
import { PagePathMapping } from '../page-mappings/entities/page-path-mapping.entity';
import { SocialPost } from '../facebook/entities/SocialPost.entity';
import { SocialProfile } from '../facebook/entities/SocialProfile.entity';
import { AnalyticsSnapshot } from '../facebook/entities/AnalyticsSnapshot.entity';

const RE_YMD = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_WINDOW_DAYS = 28;
const MAX_WINDOW_DAYS = 400;

/** Meta post platforms, which are a different axis from the traffic registry. */
const POST_PLATFORMS = ['facebook', 'instagram'] as const;
type PostPlatform = (typeof POST_PLATFORMS)[number];

export type PostSort = 'engagement' | 'reach' | 'views' | 'clicks' | 'recent';

export interface DateRange {
  start: string;
  end: string;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Shapes of the raw rows each aggregate returns.
 *
 * getRawMany() is typed `any[]`, which would make every field read below an
 * unchecked one — and these rows are the whole payload, so a select list and a
 * reader that disagree on a column name would surface as a silent zero rather
 * than an error. Numeric aggregates are declared `string` because that is what
 * the pg driver returns for SUM over int/decimal; they go through num().
 */
interface TrafficRow {
  date: string;
  source: string;
  sessions: string;
  pageviews: string;
  users: string;
  new_users: string;
  recurring_users: string;
  event_count: string;
  engagement_weighted: string;
}

interface PageRow {
  page_path: string;
  sessions: string;
  pageviews: string;
  users: string;
}

interface CampaignRow {
  campaign: string;
  medium: string;
  source: string;
  sessions: string;
  pageviews: string;
  users: string;
}

interface ProfileAggRow {
  profile_id: string;
  platform: string;
  followers_gained: string;
  unfollows: string;
  impressions: string;
  reach: string;
  engagement: string;
  profile_clicks: string;
  page_views: string;
  video_views: string;
}

interface LatestFollowersRow {
  profile_id: string;
  followers: string;
  as_of: string;
}

/**
 * Read-only social projections for the MCP server.
 *
 * Every traffic query here runs through buildSocialSourceFilter, so no call
 * path can return a non-social source. That is deliberate: the MCP answers
 * "social media traffic" questions, and the rest of the traffic dataset is
 * served by other tools against the data lake. Narrowing at the repository
 * rather than at the controller means an endpoint added later inherits the
 * restriction instead of having to remember it.
 *
 * Platform semantics are NOT redefined here — they come from
 * common/traffic-platforms, the same registry the traffic dashboard and the
 * emailed CSV read, so the MCP can never quote a Facebook number the dashboard
 * disagrees with.
 */
@Injectable()
export class McpSocialService {
  constructor(
    @InjectRepository(TrafficDaily)
    private readonly trafficRepo: Repository<TrafficDaily>,
    @InjectRepository(TrafficPageDaily)
    private readonly pageRepo: Repository<TrafficPageDaily>,
    @InjectRepository(PagePathMapping)
    private readonly pathMappingRepo: Repository<PagePathMapping>,
    @InjectRepository(SocialPost)
    private readonly postRepo: Repository<SocialPost>,
    @InjectRepository(SocialProfile)
    private readonly profileRepo: Repository<SocialProfile>,
    @InjectRepository(AnalyticsSnapshot)
    private readonly snapshotRepo: Repository<AnalyticsSnapshot>,
  ) {}

  // ── shared input handling ──────────────────────────────────────────────────

  /** Reject anything that isn't a plain ISO day before it reaches a query. */
  private day(value: string, field: string): string {
    if (!RE_YMD.test(value)) {
      throw new BadRequestException(
        `${field} must be YYYY-MM-DD (got "${value}")`,
      );
    }
    if (Number.isNaN(parseISO(value).getTime())) {
      throw new BadRequestException(`${field} is not a real date: "${value}"`);
    }
    return value;
  }

  /**
   * Resolve the requested window, defaulting to the last 28 days ending on the
   * newest day that actually has social traffic.
   *
   * Anchoring on the latest synced day rather than on today matters for the
   * same reason it does on the dashboard: the BigQuery sync runs on a lag, so a
   * window ending "today" would report the most recent day or two as zero — and
   * unlike a chart, the MCP would state that as a fact in prose.
   */
  async resolveRange(start?: string, end?: string): Promise<DateRange> {
    const anchor = end
      ? this.day(end, 'end')
      : ((await this.latestTrafficDate()) ??
        format(subDays(new Date(), 2), 'yyyy-MM-dd'));

    const from = start
      ? this.day(start, 'start')
      : format(
          subDays(parseISO(anchor), DEFAULT_WINDOW_DAYS - 1),
          'yyyy-MM-dd',
        );

    if (from > anchor) {
      throw new BadRequestException(
        `start (${from}) is after end (${anchor}).`,
      );
    }

    const spanDays =
      Math.round(
        (parseISO(anchor).getTime() - parseISO(from).getTime()) / 86_400_000,
      ) + 1;
    if (spanDays > MAX_WINDOW_DAYS) {
      throw new BadRequestException(
        `Range spans ${spanDays} days; the maximum is ${MAX_WINDOW_DAYS}.`,
      );
    }

    return { start: from, end: anchor };
  }

  /** Resolve a platform key, rejecting unknown ones rather than silently widening. */
  resolvePlatform(key?: string): TrafficPlatformDef | undefined {
    if (!key || key.toLowerCase() === 'all') return undefined;
    const platform = getTrafficPlatform(key);
    if (!platform) {
      throw new BadRequestException(
        `Unknown platform "${key}". Known: ${TRAFFIC_PLATFORMS.map(
          (p) => p.key,
        ).join(', ')}, or "all".`,
      );
    }
    return platform;
  }

  private resolvePostPlatform(key?: string): PostPlatform | undefined {
    if (!key || key.toLowerCase() === 'all') return undefined;
    // 'fb' and 'ig' are the traffic-registry spellings; accept them so one
    // vocabulary works across both halves of this API.
    const alias: Record<string, PostPlatform> = {
      fb: 'facebook',
      facebook: 'facebook',
      ig: 'instagram',
      insta: 'instagram',
      instagram: 'instagram',
    };
    const resolved = alias[key.toLowerCase().trim()];
    if (!resolved) {
      throw new BadRequestException(
        `Unknown post platform "${key}". Known: facebook, instagram, or "all".`,
      );
    }
    return resolved;
  }

  private splitIds(raw?: string): string[] | undefined {
    if (!raw) return undefined;
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50);
    return ids.length ? ids : undefined;
  }

  // ── availability ───────────────────────────────────────────────────────────

  private async latestTrafficDate(): Promise<string | null> {
    const qb = this.trafficRepo.createQueryBuilder('a');
    qb.select(`MAX(TO_CHAR(a.date, 'YYYY-MM-DD'))`, 'latest');
    qb.where('a.sessions > 0');
    const social = buildSocialSourceFilter(undefined, 'a');
    qb.andWhere(social.sql, social.params);
    const row = await qb.getRawOne<{ latest: string | null }>();
    return row?.latest ?? null;
  }

  /**
   * What the MCP can currently answer for. Each feed syncs on its own lag, so a
   * single "latest date" would be wrong for at least one of them.
   */
  async getAvailability() {
    const [traffic, page, post, snapshot, profiles] = await Promise.all([
      this.latestTrafficDate(),
      this.pageRepo
        .createQueryBuilder('p')
        .select(`MAX(TO_CHAR(p.date, 'YYYY-MM-DD'))`, 'latest')
        .getRawOne<{ latest: string | null }>(),
      this.postRepo
        .createQueryBuilder('p')
        // Reported as an IST day for the same reason getPosts filters on one:
        // the stored timestamp is UTC wall-clock (what the sync writes and what
        // the Reports page compares against), and the team reads dates in IST.
        .select(
          `MAX(TO_CHAR(p."postedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD'))`,
          'latest',
        )
        .getRawOne<{ latest: string | null }>(),
      this.snapshotRepo
        .createQueryBuilder('s')
        .select(`MAX(TO_CHAR(s.date, 'YYYY-MM-DD'))`, 'latest')
        .getRawOne<{ latest: string | null }>(),
      this.profileRepo.find({
        where: { isActive: true },
        select: ['profileId', 'name', 'platform'],
      }),
    ]);

    return {
      traffic: {
        latestDate: traffic,
        source: 'Google Analytics 4 → BigQuery → Postgres (traffic_daily)',
        note: 'Syncs on a lag of roughly 1–2 days. Windows default to ending on this date.',
      },
      landingPages: {
        latestDate: page?.latest ?? null,
        source: 'traffic_page_daily',
      },
      posts: {
        latestDate: post?.latest ?? null,
        source: 'Meta Graph API → social_posts',
      },
      pageSnapshots: {
        latestDate: snapshot?.latest ?? null,
        source: 'Meta Graph API → analytics_snapshots',
      },
      trafficPlatforms: TRAFFIC_PLATFORMS.map((p) => ({
        key: p.key,
        label: p.label,
      })),
      postPlatforms: [...POST_PLATFORMS],
      profiles: profiles.map((p) => ({
        profileId: p.profileId,
        name: p.name,
        platform: p.platform,
      })),
    };
  }

  // ── traffic ────────────────────────────────────────────────────────────────

  /**
   * Social sessions/pageviews/users for a window, split by platform and
   * optionally by day.
   *
   * Grouped by (date, utm_source) and bucketed into platforms in JS rather than
   * run once per platform: traffic_daily records one platform under many source
   * spellings, so three filtered queries would scan the same rows three times to
   * produce three numbers that have to be summed anyway.
   */
  async getTrafficSummary(opts: {
    range: DateRange;
    platform?: TrafficPlatformDef;
    daily?: boolean;
  }) {
    const { range, platform, daily = true } = opts;

    const qb = this.trafficRepo.createQueryBuilder('a');
    qb.where('a.date >= :start AND a.date <= :end', range);
    const social = buildSocialSourceFilter(platform, 'a');
    qb.andWhere(social.sql, social.params);

    qb.select([
      "TO_CHAR(a.date, 'YYYY-MM-DD') as date",
      'a.utmSource as source',
      'SUM(a.sessions) as sessions',
      'SUM(a.pageviews) as pageviews',
      'SUM(a.users) as users',
      'SUM(a.newUsers) as new_users',
      'SUM(a.recurringUsers) as recurring_users',
      'SUM(a.eventCount) as event_count',
      // Session-weighted, because a straight AVG over rows would let a source
      // with 4 sessions move the platform's engagement rate as much as one with
      // 400,000.
      'SUM(a.engagementRate * a.sessions) as engagement_weighted',
    ]);
    qb.groupBy("TO_CHAR(a.date, 'YYYY-MM-DD')");
    qb.addGroupBy('a.utmSource');
    qb.orderBy('date', 'ASC');

    const rows = await qb.getRawMany<TrafficRow>();

    const blank = (): Bucket => ({
      sessions: 0,
      pageviews: 0,
      users: 0,
      newUsers: 0,
      recurringUsers: 0,
      eventCount: 0,
      engagementWeighted: 0,
    });

    const byPlatform = new Map<string, Bucket>();
    const byDay = new Map<string, Map<string, Bucket>>();
    const overall = blank();
    // A source that passes the SQL filter but matches no bucket would otherwise
    // vanish from the totals silently. Surfacing it makes a registry rule that
    // has drifted out of step with platformForSource visible instead.
    const unbucketed = new Map<string, number>();

    for (const r of rows) {
      const def = platformForSource(r.source);
      if (!def) {
        unbucketed.set(
          r.source,
          (unbucketed.get(r.source) ?? 0) + num(r.sessions),
        );
        continue;
      }

      if (!byPlatform.has(def.key)) byPlatform.set(def.key, blank());
      addRow(byPlatform.get(def.key)!, r);
      addRow(overall, r);

      if (daily) {
        if (!byDay.has(r.date)) byDay.set(r.date, new Map());
        const dayMap = byDay.get(r.date)!;
        if (!dayMap.has(def.key)) dayMap.set(def.key, blank());
        addRow(dayMap.get(def.key)!, r);
      }
    }

    const platforms = TRAFFIC_PLATFORMS.filter(
      (p) => !platform || p.key === platform.key,
    ).map((p) => ({
      platform: p.key,
      label: p.label,
      ...shapeBucket(byPlatform.get(p.key) ?? blank()),
    }));

    return {
      range,
      scope: platform ? platform.label : 'All social platforms',
      source:
        'GA4 → BigQuery → Postgres (traffic_daily). Sessions are on-site visits driven by social.',
      totals: shapeBucket(overall),
      platforms,
      daily: daily
        ? Array.from(byDay.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, dayMap]) => {
              const dayTotal = blank();
              for (const b of dayMap.values()) mergeBucket(dayTotal, b);
              return {
                date,
                ...shapeBucket(dayTotal),
                platforms: Array.from(dayMap.entries()).map(([key, b]) => ({
                  platform: key,
                  ...shapeBucket(b),
                })),
              };
            })
        : undefined,
      unmatchedSources: unbucketed.size
        ? Array.from(unbucketed.entries()).map(([source, sessions]) => ({
            source,
            sessions,
          }))
        : undefined,
    };
  }

  /**
   * Which articles social traffic landed on.
   *
   * This is the readable breakdown for untagged organic referral (most of
   * Reddit), where utm_medium collapses the whole channel into one 'referral'
   * row and a source/medium split can say nothing useful.
   */
  async getTopPages(opts: {
    range: DateRange;
    platform?: TrafficPlatformDef;
    limit: number;
  }) {
    const { range, platform } = opts;
    const limit = Math.min(Math.max(opts.limit, 1), 200);

    const qb = this.pageRepo.createQueryBuilder('p');
    qb.where('p.date >= :start AND p.date <= :end', range);
    const social = buildSocialSourceFilter(platform, 'p');
    qb.andWhere(social.sql, social.params);

    qb.select([
      'p.pagePath as page_path',
      'SUM(p.sessions) as sessions',
      'SUM(p.pageviews) as pageviews',
      'SUM(p.users) as users',
    ]);
    qb.groupBy('p.pagePath');
    qb.orderBy('sessions', 'DESC');
    qb.limit(limit);

    const rows = await qb.getRawMany<PageRow>();
    const compiled = compilePathMappings(await this.pathMappingRepo.find());

    return {
      range,
      scope: platform ? platform.label : 'All social platforms',
      count: rows.length,
      pages: rows.map((r) => {
        const match = matchPagePath(r.page_path, compiled);
        return {
          pagePath: r.page_path,
          url: `https://www.essentiallysports.com${r.page_path}`,
          sessions: num(r.sessions),
          pageviews: num(r.pageviews),
          users: num(r.users),
          section: match?.category ?? this.sectionFromPath(r.page_path),
          pageName: match?.pageName ?? null,
          team: match?.team ?? null,
        };
      }),
    };
  }

  /** Mirrors AnalyticsService.sectionFromPath so both views group pages alike. */
  private sectionFromPath(path?: string): string {
    if (!path || path === '/') return 'Home';
    const first = path.replace(/^\//, '').split('/')[0] || '';
    const token = first.split('-')[0];
    return token ? token.toUpperCase() : 'Other';
  }

  /**
   * Tagged social traffic broken down by campaign and medium.
   *
   * Only covers links the team tagged with UTMs. Organic referral carries no
   * campaign and lands in '(not set)' — which is signal rather than a gap: it
   * is the share of social traffic nobody is attributing to a post.
   */
  async getCampaigns(opts: {
    range: DateRange;
    platform?: TrafficPlatformDef;
    limit: number;
  }) {
    const { range, platform } = opts;
    const limit = Math.min(Math.max(opts.limit, 1), 200);

    const qb = this.trafficRepo.createQueryBuilder('a');
    qb.where('a.date >= :start AND a.date <= :end', range);
    const social = buildSocialSourceFilter(platform, 'a');
    qb.andWhere(social.sql, social.params);

    qb.select([
      'a.utmCampaign as campaign',
      'a.utmMedium as medium',
      'a.utmSource as source',
      'SUM(a.sessions) as sessions',
      'SUM(a.pageviews) as pageviews',
      'SUM(a.users) as users',
    ]);
    qb.groupBy('a.utmCampaign');
    qb.addGroupBy('a.utmMedium');
    qb.addGroupBy('a.utmSource');
    qb.orderBy('sessions', 'DESC');
    qb.limit(limit);

    const rows = await qb.getRawMany<CampaignRow>();

    return {
      range,
      scope: platform ? platform.label : 'All social platforms',
      count: rows.length,
      note: "Untagged organic referral carries no campaign and appears as '(not set)'.",
      campaigns: rows.map((r) => ({
        campaign: r.campaign,
        medium: r.medium,
        source: r.source,
        platform: platformForSource(r.source)?.key ?? null,
        sessions: num(r.sessions),
        pageviews: num(r.pageviews),
        users: num(r.users),
      })),
    };
  }

  // ── owned-account performance (the Reports page) ───────────────────────────

  /**
   * Per-post performance for the owned Meta accounts.
   *
   * A different question from the traffic endpoints above: this measures how a
   * POST did on the platform (reach, engagement), not how much traffic it sent
   * to the site. A post can take enormous reach and send nobody, and the two
   * datasets share no join key, so they are reported side by side and never
   * mixed into one number.
   */
  async getPosts(opts: {
    range: DateRange;
    platform?: string;
    profileIds?: string;
    limit: number;
    sortBy: PostSort;
  }) {
    const { range } = opts;
    const limit = Math.min(Math.max(opts.limit, 1), 200);
    const platform = this.resolvePostPlatform(opts.platform);
    const profileIds = this.splitIds(opts.profileIds);

    const qb = this.postRepo.createQueryBuilder('p');
    // Day boundaries in IST, matching the Reports page verbatim.
    //
    // postedAt is a timestamp, so "posts on the 10th" needs a timezone to mean
    // anything, and the Studio UI resolves it at +05:30. Using UTC here instead
    // would shift the window by five and a half hours and quietly return a
    // different set of posts than the page the team is looking at — the exact
    // disagreement this integration exists to avoid.
    qb.where('p.postedAt >= :start AND p.postedAt <= :end', {
      start: new Date(`${range.start}T00:00:00.000+05:30`).toISOString(),
      end: new Date(`${range.end}T23:59:59.999+05:30`).toISOString(),
    });
    if (platform) qb.andWhere('p.platform = :platform', { platform });
    if (profileIds)
      qb.andWhere('p.profileId IN (:...profileIds)', { profileIds });

    const engagement = '(p.likes + p.comments + p.shares + p.clicks)';
    const orderBy: Record<PostSort, string> = {
      engagement,
      reach: 'p.reach',
      views: 'p.views',
      clicks: 'p.clicks',
      recent: 'p.postedAt',
    };
    qb.orderBy(orderBy[opts.sortBy] ?? engagement, 'DESC');
    qb.limit(limit);

    const posts = await qb.getMany();

    const profiles = await this.profileRepo.find({
      select: ['profileId', 'name', 'platform'],
    });
    const nameById = new Map(profiles.map((p) => [p.profileId, p.name]));

    return {
      range,
      scope: platform ?? 'facebook + instagram',
      sortedBy: opts.sortBy,
      count: posts.length,
      note: 'On-platform post performance. These are NOT site sessions — use the traffic endpoints for traffic sent to essentiallysports.com.',
      posts: posts.map((p) => {
        const eng = p.likes + p.comments + p.shares + p.clicks;
        return {
          postId: p.postId,
          profileId: p.profileId,
          profileName: nameById.get(p.profileId) ?? null,
          platform: p.platform,
          postType: p.postType,
          postedAt: p.postedAt,
          message: p.message ? p.message.slice(0, 400) : null,
          permalink: p.permalink,
          isBoosted: p.isBoosted,
          likes: p.likes,
          comments: p.comments,
          shares: p.shares,
          clicks: p.clicks,
          reach: p.reach,
          views: p.views,
          engagement: eng,
          engagementRatePct: p.reach
            ? Math.round((eng / p.reach) * 10000) / 100
            : null,
        };
      }),
    };
  }

  /**
   * Page-level totals per owned account: followers, reach, impressions,
   * engagement — the Reports page overview, aggregated in SQL.
   */
  async getProfilePerformance(opts: {
    range: DateRange;
    platform?: string;
    profileIds?: string;
  }) {
    const { range } = opts;
    const platform = this.resolvePostPlatform(opts.platform);
    const profileIds = this.splitIds(opts.profileIds);

    const qb = this.snapshotRepo.createQueryBuilder('s');
    qb.where('s.date >= :start AND s.date <= :end', range);
    if (platform) qb.andWhere('s.platform = :platform', { platform });
    if (profileIds)
      qb.andWhere('s.profileId IN (:...profileIds)', { profileIds });

    qb.select([
      's.profileId as profile_id',
      's.platform as platform',
      'SUM(s.followersGained) as followers_gained',
      'SUM(s.unfollows) as unfollows',
      // Reach and impressions are separate Meta metrics and some page types
      // report only one of them. GREATEST is what the Reports page uses, so a
      // page missing impressions still contributes its reach.
      'SUM(GREATEST(s.totalImpressions, s.totalReach)) as impressions',
      'SUM(s.totalReach) as reach',
      'SUM(s.totalEngagement) as engagement',
      'SUM(s.profileClicks) as profile_clicks',
      'SUM(s.pageViews) as page_views',
      'SUM(s.videoViews) as video_views',
    ]);
    qb.groupBy('s.profileId');
    qb.addGroupBy('s.platform');
    qb.orderBy('impressions', 'DESC');

    const rows = await qb.getRawMany<ProfileAggRow>();

    // The follower count as of the last day in the window, per profile. A SUM
    // would be meaningless and a MAX would hide a decline.
    const latest = await this.snapshotRepo
      .createQueryBuilder('s')
      .select('DISTINCT ON (s."profileId") s."profileId"', 'profile_id')
      .addSelect('s."totalFollowers"', 'followers')
      .addSelect(`TO_CHAR(s.date, 'YYYY-MM-DD')`, 'as_of')
      .where('s.date >= :start AND s.date <= :end', range)
      .orderBy('s."profileId"')
      .addOrderBy('s.date', 'DESC')
      .getRawMany<LatestFollowersRow>();
    const latestById = new Map(latest.map((r) => [r.profile_id, r]));

    const profiles = await this.profileRepo.find({
      select: ['profileId', 'name', 'platform'],
    });
    const nameById = new Map(profiles.map((p) => [p.profileId, p.name]));

    return {
      range,
      scope: platform ?? 'facebook + instagram',
      count: rows.length,
      note: 'On-platform account performance. Not site traffic.',
      profiles: rows.map((r) => ({
        profileId: r.profile_id,
        profileName: nameById.get(r.profile_id) ?? null,
        platform: r.platform,
        followers: num(latestById.get(r.profile_id)?.followers),
        followersAsOf: latestById.get(r.profile_id)?.as_of ?? null,
        followersGained: num(r.followers_gained),
        unfollows: num(r.unfollows),
        netFollowerChange: num(r.followers_gained) - num(r.unfollows),
        impressions: num(r.impressions),
        reach: num(r.reach),
        engagement: num(r.engagement),
        profileClicks: num(r.profile_clicks),
        pageViews: num(r.page_views),
        videoViews: num(r.video_views),
      })),
    };
  }
}

// ── traffic aggregation helpers ──────────────────────────────────────────────

interface Bucket {
  sessions: number;
  pageviews: number;
  users: number;
  newUsers: number;
  recurringUsers: number;
  eventCount: number;
  /** engagementRate × sessions, divided back out at render time. */
  engagementWeighted: number;
}

function addRow(b: Bucket, r: TrafficRow): void {
  b.sessions += num(r.sessions);
  b.pageviews += num(r.pageviews);
  b.users += num(r.users);
  b.newUsers += num(r.new_users);
  b.recurringUsers += num(r.recurring_users);
  b.eventCount += num(r.event_count);
  b.engagementWeighted += num(r.engagement_weighted);
}

function mergeBucket(target: Bucket, source: Bucket): void {
  target.sessions += source.sessions;
  target.pageviews += source.pageviews;
  target.users += source.users;
  target.newUsers += source.newUsers;
  target.recurringUsers += source.recurringUsers;
  target.eventCount += source.eventCount;
  target.engagementWeighted += source.engagementWeighted;
}

function shapeBucket(b: Bucket) {
  return {
    sessions: b.sessions,
    pageviews: b.pageviews,
    users: b.users,
    newUsers: b.newUsers,
    recurringUsers: b.recurringUsers,
    eventCount: b.eventCount,
    engagementRatePct: b.sessions
      ? Math.round((b.engagementWeighted / b.sessions) * 10000) / 100
      : 0,
  };
}
