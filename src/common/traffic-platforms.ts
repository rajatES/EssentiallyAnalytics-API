/**
 * Single source of truth for "which utm_source values belong to which platform".
 *
 * Google Analytics reports one platform under many spellings — casing drift
 * ('fb' / 'Fb' / 'Facebook'), referrer subdomains ('l.facebook.com',
 * 'out.reddit.com'), and in-app referrers ('ig_text_feed_timeline') — so a
 * platform tab can never be a single equality check. Both the traffic
 * dashboard and the emailed traffic CSV resolve their source filter through
 * here, so the two can no longer disagree.
 *
 * Match rules, all evaluated against LOWER(utm_source):
 *   exact    — full-string equality
 *   domains  — the bare domain plus any subdomain of it. 'reddit.com' matches
 *              'reddit.com' and 'out.reddit.com' but NOT 'redditate.com'
 *   prefixes — starts-with, for in-app referrers and for links whose query
 *              string leaked into the source ('threads&utm_medium=...')
 */

export type TrafficPlatformKey = 'fb' | 'threads' | 'reddit';

export interface TrafficPlatformDef {
  key: TrafficPlatformKey;
  /** Label shown in the UI. */
  label: string;
  /** Short label used in CSV titles and email subjects. */
  shortLabel: string;
  exact: string[];
  domains: string[];
  prefixes: string[];
}

export const TRAFFIC_PLATFORMS: TrafficPlatformDef[] = [
  {
    key: 'fb',
    label: 'Facebook',
    shortLabel: 'FB',
    // Deliberately not a '%ig%' wildcard. That pattern (previously used by the
    // email report) also matched 'aigeon', 'huddle-website-signup.beehiiv.com'
    // and 'tigernet.com' — ~177k sessions of non-Facebook traffic.
    exact: ['fb', 'facebook', 'facebook_share', 'fb.me', 'ig', 'instagram'],
    domains: ['facebook.com', 'instagram.com'],
    prefixes: ['ig_text_'],
  },
  {
    key: 'threads',
    label: 'Threads',
    shortLabel: 'Threads',
    exact: ['threads', 'threads.com', 'threads.net'],
    domains: ['threads.com', 'threads.net'],
    // Some links were built with an unencoded '&', so the whole query string
    // landed in utm_source ('threads&utm_medium=es_main&utm_campaign=tennis').
    prefixes: ['threads&'],
  },
  {
    key: 'reddit',
    label: 'Reddit',
    shortLabel: 'Reddit',
    // 'subreddit' and 'reddit' are the UTM-tagged posting sources; the
    // *.reddit.com domains are untagged organic referral. Both are Reddit
    // traffic, and since mid-2026 the organic half is the larger one.
    exact: [
      'reddit',
      'subreddit',
      'reddit_share',
      'www-reddit-com.translate.goog',
    ],
    domains: ['reddit.com'],
    prefixes: [],
  },
];

export const DEFAULT_TRAFFIC_PLATFORM: TrafficPlatformKey = 'fb';

export function getTrafficPlatform(
  key: string,
): TrafficPlatformDef | undefined {
  const lower = key.trim().toLowerCase();
  return TRAFFIC_PLATFORMS.find((p) => p.key === lower);
}

/**
 * Resolve a raw `utmSource` query param to a platform.
 *
 * The controller wraps every query param in an array, so this has to accept
 * both shapes — an earlier version compared the raw value to the string 'fb',
 * which silently never matched once the array wrapping was introduced.
 */
export function resolveTrafficPlatform(
  value?: string | string[],
): TrafficPlatformDef | undefined {
  if (!value) return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (values.length !== 1) return undefined;
  return getTrafficPlatform(String(values[0]));
}

/** Escape LIKE metacharacters so '_' in a prefix stays a literal underscore. */
function escapeLike(value: string): string {
  return value.replace(/([%_\\])/g, '\\$1');
}

/**
 * Build the SQL fragment + bound params that match every source spelling for a
 * platform. Returns a single parenthesised OR-group safe to pass to andWhere().
 *
 * `paramPrefix` must be unique per query builder alias, otherwise two filters
 * in the same query would clobber each other's bound parameters.
 */
export function buildPlatformSourceFilter(
  platform: TrafficPlatformDef,
  alias = 'a',
  column = 'utmSource',
  paramPrefix = 'plat',
): { sql: string; params: Record<string, any> } {
  const col = `LOWER(${alias}.${column})`;
  const clauses: string[] = [];
  const params: Record<string, any> = {};

  if (platform.exact.length) {
    const key = `${paramPrefix}_exact`;
    clauses.push(`${col} IN (:...${key})`);
    params[key] = platform.exact.map((s) => s.toLowerCase());
  }

  platform.domains.forEach((domain, i) => {
    const bare = `${paramPrefix}_dom${i}`;
    const sub = `${paramPrefix}_sub${i}`;
    clauses.push(`${col} = :${bare}`);
    clauses.push(`${col} LIKE :${sub}`);
    params[bare] = domain.toLowerCase();
    params[sub] = `%.${escapeLike(domain.toLowerCase())}`;
  });

  platform.prefixes.forEach((prefix, i) => {
    const key = `${paramPrefix}_pfx${i}`;
    clauses.push(`${col} LIKE :${key}`);
    params[key] = `${escapeLike(prefix.toLowerCase())}%`;
  });

  return { sql: `(${clauses.join(' OR ')})`, params };
}

/** Reject anything that isn't a plain source token, so literals can be inlined. */
function assertSafeLiteral(value: string): string {
  if (!/^[a-z0-9._&-]+$/.test(value)) {
    throw new Error(`Unsafe traffic-platform source literal: ${value}`);
  }
  return value;
}

/**
 * Same matching rules as buildPlatformSourceFilter, rendered as standalone
 * BigQuery SQL with the values inlined.
 *
 * BigQuery uses @named parameters rather than TypeORM's :named ones, and this
 * predicate is embedded inside a CREATE TABLE statement, so inlining is simpler
 * than threading params through. Every value comes from the hardcoded registry
 * above and is re-validated by assertSafeLiteral, so there is no injection path.
 *
 * Pass no platform to match all of them (used when building the shared
 * page-level aggregate, which stores every platform in one table).
 */
export function buildPlatformSourceSqlBQ(
  column: string,
  platform?: TrafficPlatformDef,
): string {
  const targets = platform ? [platform] : TRAFFIC_PLATFORMS;
  const col = `LOWER(${column})`;
  const clauses: string[] = [];

  const exact = targets.flatMap((p) => p.exact).map(assertSafeLiteral);
  if (exact.length) {
    clauses.push(`${col} IN (${exact.map((s) => `'${s}'`).join(', ')})`);
  }

  for (const p of targets) {
    for (const domain of p.domains.map(assertSafeLiteral)) {
      clauses.push(`${col} = '${domain}'`);
      clauses.push(`ENDS_WITH(${col}, '.${domain}')`);
    }
    for (const prefix of p.prefixes.map(assertSafeLiteral)) {
      clauses.push(`STARTS_WITH(${col}, '${prefix}')`);
    }
  }

  return `(${clauses.join(' OR ')})`;
}
