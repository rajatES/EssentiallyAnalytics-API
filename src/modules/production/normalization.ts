import * as crypto from 'crypto';

/**
 * Parsing / canonicalisation helpers for the production aggregate sheets
 * (Critical Flow, Yahoo).
 *
 * Everything here is defensive about cell types: the n8n workflow writes ISO
 * strings, but Google Sheets silently coerces anything date-shaped into a real
 * date value, so the same column can come back as a serial number on one sync
 * and a string on the next. Every parser accepts both.
 */

// ── Primitives ──

/** Trim and collapse internal whitespace. */
export function clean(raw: any): string {
  if (raw == null) return '';
  return String(raw).replace(/\s+/g, ' ').trim();
}

const SHEET_EPOCH_OFFSET = 25569; // days between 1899-12-30 and 1970-01-01

function isReasonableDate(d: Date): boolean {
  if (isNaN(d.getTime())) return false;
  const y = d.getFullYear();
  return y >= 2015 && y <= 2100;
}

/**
 * Accepts an ISO-8601 string (what the workflow writes), a Sheets serial
 * number (what Sheets returns once it has coerced that string), or a Date.
 */
export function parseDateTime(raw: any): Date | null {
  if (raw == null || raw === '') return null;

  if (raw instanceof Date) return isReasonableDate(raw) ? raw : null;

  if (typeof raw === 'number') {
    if (!isFinite(raw) || raw < 30000 || raw > 60000) return null;
    const d = new Date(Math.round((raw - SHEET_EPOCH_OFFSET) * 86400000));
    return isReasonableDate(d) ? d : null;
  }

  const s = String(raw).trim();
  if (!s) return null;

  // ISO — the canonical form the workflow writes. Treated as wall-clock, which
  // is what the source sheets record.
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/.test(s)) {
    const d = new Date(s.replace(' ', 'T'));
    return isReasonableDate(d) ? d : null;
  }

  // A serial that arrived as text.
  if (/^\d+(\.\d+)?$/.test(s)) return parseDateTime(Number(s));

  const d = new Date(s);
  return isReasonableDate(d) ? d : null;
}

/** Date-only (YYYY-MM-DD) from any accepted date representation. */
export function parseDateOnly(raw: any): string | null {
  const d = parseDateTime(raw);
  return d ? toDateOnly(d) : null;
}

export function toDateOnly(d: Date | null): string | null {
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Non-negative finite number, or null. Blank/junk cells become null. */
export function parseNumber(raw: any): number | null {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!isFinite(n) || n < 0) return null;
  return n;
}

/**
 * The Yahoo/Newsbreak flag. Blank stays null so "not filled in" can be told
 * apart from an explicit "No" — the two mean different things when a division
 * is being measured on syndication coverage.
 */
export function parseYahoo(raw: any): boolean | null {
  const s = clean(raw).toLowerCase();
  if (!s) return null;
  if (s === 'yes' || s === 'y' || s === 'true' || s === '1') return true;
  if (s === 'no' || s === 'n' || s === 'false' || s === '0') return false;
  return null;
}

// ── Vocabularies ──

/**
 * Editorial status. The source uses a small vocabulary but with drifting case
 * and spacing; anything unrecognised is title-cased and kept rather than
 * collapsed into "Unknown", so a new status shows up in the UI instead of
 * silently merging into an existing bucket.
 */
const STATUS_ALIASES: Record<string, string> = {
  verified: 'Verified',
  verifying: 'Verifying',
  'sent back': 'Sent Back',
  sentback: 'Sent Back',
  sb: 'Sent Back',
  scrapped: 'Scrapped',
  scraped: 'Scrapped',
  trashed: 'Scrapped',
  'on hold': 'On Hold',
  onhold: 'On Hold',
  hold: 'On Hold',
  'pr published': 'PR Published',
  published: 'Published',
  scheduled: 'Scheduled',
};

export function normalizeStatus(raw: any): string {
  const s = clean(raw);
  if (!s) return '';
  return STATUS_ALIASES[s.toLowerCase()] ?? titleCase(s);
}

const ARTICLE_TYPE_ALIASES: Record<string, string> = {
  'trend setter': 'Trend Setter',
  trendsetter: 'Trend Setter',
  ts: 'Trend Setter',
  'in-depth': 'In-Depth',
  'in depth': 'In-Depth',
  indepth: 'In-Depth',
  'quick hit': 'Quick Hit',
  quickhit: 'Quick Hit',
  qh: 'Quick Hit',
  stable: 'Stable',
};

export function normalizeArticleType(raw: any): string {
  const s = clean(raw);
  if (!s) return 'Unknown';
  return ARTICLE_TYPE_ALIASES[s.toLowerCase()] ?? titleCase(s);
}

/**
 * Send-back reasons. "Lack of BBT (…)" is a family with drifting spellings of
 * the qualifier ("Relevent"/"Relevant", "Related"/"Relatability"), so the
 * family is kept as one bucket with the qualifier preserved for detail.
 */
export function normalizeSbReason(raw: any): string {
  const s = clean(raw);
  if (!s) return '';
  const low = s.toLowerCase();
  if (low.startsWith('lack of bbt')) {
    const m = s.match(/\(([^)]*)\)/);
    return m ? `Lack of BBT (${titleCase(m[1])})` : 'Lack of BBT';
  }
  return titleCase(s);
}

/** Coarse role bucket used for availability and workload views. */
export function classifyRole(role: string): string {
  const r = clean(role).toLowerCase();
  if (!r) return 'other';
  if (/(group head|gh\b|lead|strategist|analyst|social media)/.test(r)) return 'lead';
  if (/editor/.test(r)) return 'editor';
  if (/writer|intern|jep\b|\bft\b|\bpt\b/.test(r)) return 'writer';
  return 'other';
}

function titleCase(s: string): string {
  return s
    .split(' ')
    .map((w) => (w.length > 2 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Person / division names: whitespace-normalised, case preserved. */
export function normalizePerson(raw: any): string {
  const s = clean(raw);
  return s || 'Unknown';
}

export function normalizeDivision(raw: any): string {
  const s = clean(raw);
  return s || 'Unknown';
}

/**
 * Title key for duplicate detection — case, punctuation and the curly/straight
 * quote distinction all removed, since the same headline is routinely retyped
 * with different quote characters across divisions.
 */
export function normalizeTitleKey(title: string): string {
  return clean(title)
    .toLowerCase()
    .replace(/[‘’“”]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function computeRowHash(values: any[]): string {
  return crypto
    .createHash('sha1')
    .update(values.map((v) => (v == null ? '' : String(v))).join(''))
    .digest('hex')
    .slice(0, 16);
}

/** A piece needs an identity and a title to be worth storing. */
export function isValidPiece(p: { id: string; title: string }): boolean {
  return !!p.id && !!p.title;
}
