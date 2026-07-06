// Static presentation/targets config for the syndication reports —
// carried over from the retired Google Sheet ("MSN Targets" tab +
// appscript.js FEED_NAMES / tier column groupings). Served to the UI via
// GET /v1/msn-production/reports/config so the Reports tab can show the
// same short names, region-tier view groupings, and published-vs-target
// comparisons the sheet did. If targets need to become editable, move this
// into a table and keep the endpoint shape.

/** Region tiers used to group the per-region view columns (sheet X:AF etc.). */
export const REGION_TIERS: Record<string, string[]> = {
  T1: ['USA', 'UK', 'CAN', 'AUS', 'NZ'],
  T2: ['MY', 'PH', 'SGPR'],
  T3: ['IN'],
};

export interface PublicationConfig {
  /** Short display name used in the sheet (e.g. "NJ"). */
  shortName: string;
  /** Publication tier from the Targets tab (T1 | T2 | T3). */
  tier: string;
  /** Daily published-content targets per type. */
  targets: { article: number; slideshow: number; video: number };
}

/** Order mirrors the Targets tab (tier, then feed). */
export const PUBLICATIONS: Record<string, PublicationConfig> = {
  'Netflix Junkie': { shortName: 'NJ', tier: 'T1', targets: { article: 12, slideshow: 16, video: 8 } },
  'Inde News': { shortName: 'Inde News', tier: 'T1', targets: { article: 8, slideshow: 8, video: 8 } },
  'RFK Racing Digest': { shortName: 'RFK Racing', tier: 'T1', targets: { article: 12, slideshow: 16, video: 8 } },
  'Daytona Racing Digest': { shortName: 'Daytona Racing', tier: 'T1', targets: { article: 8, slideshow: 12, video: 8 } },
  'Club Golf': { shortName: 'Club Golf', tier: 'T1', targets: { article: 18, slideshow: 12, video: 8 } },
  'Bodybuilding Bros': { shortName: 'Bodybuilding Bros', tier: 'T1', targets: { article: 12, slideshow: 12, video: 8 } },
  'NHL Fan Central': { shortName: 'NHL', tier: 'T1', targets: { article: 15, slideshow: 8, video: 8 } },
  'Quarter Back Central': { shortName: 'QB Central', tier: 'T2', targets: { article: 8, slideshow: 8, video: 5 } },
  'Cleveland Browns Community': { shortName: 'Browns', tier: 'T2', targets: { article: 8, slideshow: 8, video: 5 } },
  'Dallas Cowboys Community': { shortName: 'Dallas Cowboys', tier: 'T2', targets: { article: 8, slideshow: 8, video: 5 } },
  'Michigan Football Community': { shortName: 'Michigan FB', tier: 'T2', targets: { article: 8, slideshow: 8, video: 5 } },
  'Detroit Lions Community': { shortName: 'Detroit Lions', tier: 'T2', targets: { article: 8, slideshow: 8, video: 5 } },
  'Kansas City Chiefs Community': { shortName: 'KCC', tier: 'T2', targets: { article: 8, slideshow: 8, video: 5 } },
  'Cincinnati Bengals Community': { shortName: 'Bengals', tier: 'T2', targets: { article: 8, slideshow: 8, video: 5 } },
  'Denver Broncos Community': { shortName: 'Broncos', tier: 'T2', targets: { article: 8, slideshow: 12, video: 5 } },
  'Her Sports Nation': { shortName: 'HSN', tier: 'T2', targets: { article: 10, slideshow: 12, video: 5 } },
  'Air Jordan Chronicles': { shortName: 'Air Jordan', tier: 'T2', targets: { article: 12, slideshow: 12, video: 5 } },
  'Gaming Community by Max Level': { shortName: 'Gaming Community by Max Level', tier: 'T2', targets: { article: 12, slideshow: 30, video: 5 } },
  'Motor Culture': { shortName: 'Motor Culture', tier: 'T3', targets: { article: 1, slideshow: 8, video: 6 } },
  'New York Yankees Community': { shortName: 'Yankees', tier: 'T3', targets: { article: 1, slideshow: 12, video: 3 } },
  'Ace Badminton Community': { shortName: 'Badminton', tier: 'T3', targets: { article: 0, slideshow: 10, video: 3 } },
  'Gymnastics Digest': { shortName: 'Gymnastics', tier: 'T3', targets: { article: 0, slideshow: 12, video: 3 } },
  "Swimmer's Club": { shortName: 'Swimmers', tier: 'T3', targets: { article: 0, slideshow: 10, video: 3 } },
};

export function getReportsConfig() {
  return {
    regionTiers: REGION_TIERS,
    publications: PUBLICATIONS,
  };
}
