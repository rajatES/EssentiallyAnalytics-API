import { clean } from '../production/normalization';

/**
 * Vocabulary and lifecycle rules for the Stable source sheet.
 *
 * The desk records no timestamps worth trusting, so every number on the page
 * is a snapshot of where each piece stands right now, grouped by event tab.
 * These rules are the single definition of each stage, shared by every surface.
 */

export type StableStage =
  | 'Awaiting Submission'
  | 'Awaiting Editorial'
  | 'In Editorial'
  | 'Sent Back'
  | 'Verified'
  | 'Published'
  | 'On Hold'
  | 'Trashed';

/** Display order, from first to last in the lifecycle. */
export const STAGE_ORDER: StableStage[] = [
  'Awaiting Submission',
  'Awaiting Editorial',
  'In Editorial',
  'Sent Back',
  'Verified',
  'Published',
  'On Hold',
  'Trashed',
];

/** Stages that still need someone to act. */
export const OPEN_STAGES = new Set<StableStage>([
  'Awaiting Submission',
  'Awaiting Editorial',
  'In Editorial',
  'Sent Back',
]);

// ── Stable type ──

const TYPE_RULES: [RegExp, string][] = [
  [
    /^(ex[\s-]*)?(wags?|wife|husband|girl\s*friend|boy\s*friend|partner|spouse|relationship)/i,
    'WAGs',
  ],
  [/^parents?'?$|^parents?\b/i, 'Parents'],
  [/^net\s*worth|^contract|^salary/i, 'Net Worth'],
  [/^(ethnicity|nationality|religion)/i, 'Ethnicity'],
  [/^(kids|children|child)\b/i, 'Children'],
  [/^(siblings?|silbings?|brothers?|sisters?)\b/i, 'Siblings'],
  [/^round[\s-]*up/i, 'Round-up'],
  [/^(search\s*piece|who\s*is)/i, 'Search Piece'],
  [/^coach/i, 'Coach'],
  [/^nil$/i, 'NIL'],
];

/**
 * The type column drifts in case, plurals and synonyms ("WAGS", "WAGs",
 * "Wife", "Girlfriend"), which would otherwise split one stable into five
 * buckets. A cell that is really a headline typed into the wrong column is
 * kept out of the mix as "Other" rather than becoming a type of its own.
 */
export function normalizeStableType(raw: unknown): string {
  const s = clean(raw);
  if (!s) return 'Unspecified';
  for (const [re, label] of TYPE_RULES) if (re.test(s)) return label;
  if (s.length > 30) return 'Other';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "New" or "Update"; anything else in that column is a mis-entry. */
export function normalizePieceKind(raw: unknown): string {
  const s = clean(raw).toLowerCase();
  if (s === 'new') return 'New';
  if (/^updat/.test(s) || s === 'update piece') return 'Update';
  return '';
}

// ── Editing status ──

const STATUS_ALIASES: Record<string, string> = {
  verified: 'Verified',
  verifed: 'Verified',
  verifying: 'Verifying',
  sentback: 'Sent Back',
  'sent back': 'Sent Back',
  'on hold': 'On Hold',
  onhold: 'On Hold',
  trashed: 'Trashed',
  scrapped: 'Trashed',
  published: 'Published',
  scheduled: 'Scheduled',
};

export function normalizeEditingStatus(raw: unknown): string {
  const s = clean(raw);
  if (!s) return '';
  return STATUS_ALIASES[s.toLowerCase()] ?? s;
}

// ── People ──

/**
 * Editor cells sometimes name a role instead of a person ("Divison Editor",
 * "Tennis Divison Editor") — the piece went to a division editor outside the
 * desk. Those collapse to one bucket rather than reading as three people.
 */
export function normalizeStablePerson(raw: unknown): string {
  const s = clean(raw);
  if (!s || /^https?:\/\//i.test(s)) return 'Unknown';
  if (/divis?i?on\s+editor/i.test(s)) return 'Division Editor';
  return s;
}

// ── Links ──

const STAGING_RE = /wp-admin|staging\.essentiallysports|post\.php\?post=/i;
const DOC_RE = /docs\.google\.com/i;

/**
 * Tabs disagree on which of "Submission Doc Link" and "Staging Link" holds
 * what — several put the WordPress staging URL under the submission header —
 * so links are routed by what they point at, not by the column they sit in.
 */
export function routeLinks(cells: unknown[]): {
  stagingLink: string;
  submissionDoc: string;
} {
  let stagingLink = '';
  let submissionDoc = '';
  for (const c of cells) {
    const v = clean(c);
    if (!v) continue;
    if (!stagingLink && STAGING_RE.test(v)) stagingLink = v;
    else if (!submissionDoc && DOC_RE.test(v)) submissionDoc = v;
  }
  return { stagingLink, submissionDoc };
}

// ── Publication ──

const MARKER_RE = /^(published|scheduled?|schd|sch|live)\.?$/i;
const CLOCK_RE = /\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\s*(am|pm)\b/i;

/**
 * The desk saves stables as drafts ("NO STABLES TO BE PUBLISHED. SAVE AFTER
 * DRAFTING") and whoever schedules them notes it wherever is to hand: a
 * Published URL, a clock time or "schd" under Scheduling Time, or "Scheduled"
 * typed into the comments or verification column. Any of those counts. A
 * whole-cell match keeps "Not to be published" from reading as published.
 */
export function hasPublishMarker(input: {
  publishedUrl: string;
  schedulingRaw: unknown;
  notes: string[];
}): boolean {
  if (input.publishedUrl) return true;
  const sched = input.schedulingRaw;
  if (typeof sched === 'number' && isFinite(sched) && sched > 0) return true;
  const s = clean(sched);
  if (s && (MARKER_RE.test(s) || CLOCK_RE.test(s))) return true;
  return input.notes.some((n) => MARKER_RE.test(clean(n)));
}

// ── Stage ──

export function stageOf(p: {
  editingStatus: string;
  stagingLink: string;
  submissionDoc: string;
  published: boolean;
}): StableStage {
  const st = p.editingStatus;
  if (st === 'Trashed') return 'Trashed';
  if (st === 'On Hold') return 'On Hold';
  if (p.published || st === 'Published' || st === 'Scheduled')
    return 'Published';
  if (st === 'Verified') return 'Verified';
  if (st === 'Sent Back') return 'Sent Back';
  // Any other status ("Verifying", or a note like "staging link missing") means
  // an editor has the piece.
  if (st) return 'In Editorial';
  if (p.stagingLink || p.submissionDoc) return 'Awaiting Editorial';
  return 'Awaiting Submission';
}

export function isSubmittedStage(s: StableStage): boolean {
  return s !== 'Awaiting Submission';
}

/** Cleared by an editor — verified, or already scheduled / live. */
export function isVerifiedStage(s: StableStage): boolean {
  return s === 'Verified' || s === 'Published';
}

// ── Sport ──

const SPORT_RULES: [RegExp, string][] = [
  [/\bwnba\b/i, 'WNBA'],
  [/\bnba\b/i, 'NBA'],
  [/\bncaa|march madness/i, 'NCAA Basketball'],
  [/\bcfb\b|college football|ncaa-college-football/i, 'College Football'],
  [/\bnfl\b/i, 'NFL'],
  [/\bmlb\b/i, 'MLB'],
  [/nascar/i, 'NASCAR'],
  [/wimbledon|french open|australian open|tennis/i, 'Tennis'],
  [/\bpga\b|masters?\s*golf|st\.?\s*jude|golf|ryder/i, 'Golf'],
  [/fifa|world cup|soccer/i, 'Soccer'],
  [/olympic|enhanced games/i, 'Olympics'],
  [/\bufc\b|boxing|wwe/i, 'Combat'],
];

/**
 * The sport an event tab belongs to. Tab names are tried first; the banner's
 * slug note ("[Slug: /tennis-news]") settles names like "US Open" that could
 * belong to more than one sport.
 */
export function sportOf(tab: string, banner: string): string {
  const slug =
    (banner.match(/slug:?\s*\[?\s*\/?\s*([a-z0-9-]+)/i) || [])[1] || '';
  if (/tennis/i.test(slug)) return 'Tennis';
  for (const [re, label] of SPORT_RULES) if (re.test(tab)) return label;
  for (const [re, label] of SPORT_RULES)
    if (slug && re.test(slug)) return label;
  if (/us open/i.test(tab)) return 'Tennis';
  return 'Other';
}

// ── Names ──

/** Edit distance, for catching one-letter misspellings of rostered names. */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return d[m][n];
}
