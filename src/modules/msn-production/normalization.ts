import * as crypto from 'crypto';

// ── Alias maps ──

const FEED_ALIASES: Record<string, string> = {
  bengals: 'Bengals',
  broncos: 'Broncos',
  browns: 'Browns',
  chiefs: 'Chiefs',
  kcc: 'Chiefs',
  'kansas city huddle': 'Chiefs',
  cowboys: 'Cowboys',
  'dallas cowboys': 'Cowboys',
  lions: 'Lions',
  michigan: 'Michigan',
  wolverines: 'Michigan',
  'qb central': 'QB Central',
  qbc: 'QB Central',
  qbcentral: 'QB Central',
  'quarterback central': 'QB Central',
  'quaterback central': 'QB Central',
};

const WRITER_ALIASES: Record<string, string> = {
  aaindri: 'Aaindri Thakur',
  'aaindri thakur': 'Aaindri Thakur',
  'aaindri thakuri': 'Aaindri Thakur',
  'aindri thakuri': 'Aaindri Thakur',
  aadinri: 'Aaindri Thakur',
  aaradhya: 'Aaradhya',
  aradhya: 'Aaradhya',
  aaron: 'Aaron',
  abhay: 'Abhay',
  akanksha: 'Akanksha Biradar',
  akansha: 'Akanksha Biradar',
  aknaksha: 'Akanksha Biradar',
  'akanksha biradar': 'Akanksha Biradar',
  anjali: 'Anjali',
  ankita: 'Ankita',
  anshuman: 'Anshuman Aryan',
  'anshuman aryan': 'Anshuman Aryan',
  anugya: 'Anugya',
  apeksha: 'Apeksha',
  archana: 'Archana',
  arijit: 'Arijit',
  arjit: 'Arijit',
  arundhoti: 'Arundhoti',
  darshan: 'Darshanbir',
  darshanbir: 'Darshanbir',
  debanjali: 'Debanjali',
  devyanshi: 'Divyanshi Raj',
  divyanshi: 'Divyanshi Raj',
  'divyanshi raj': 'Divyanshi Raj',
  dheeraj: 'Dheeraj',
  dhruv: 'Dhruv Nair',
  'dhruv nair': 'Dhruv Nair',
  eklavya: 'Eklavya',
  evince: 'Evince',
  farheen: 'Farheen',
  harshita: 'Harshita Saxena',
  'harshita saxena': 'Harshita Saxena',
  hetal: 'Hetal',
  insiya: 'Insiya Johar',
  'insiya johar': 'Insiya Johar',
  jacob: 'Jacob Gijy',
  'jacob gijy': 'Jacob Gijy',
  manoj: 'Manoj',
  maria: 'Maria',
  monica: 'Monica',
  monika: 'Monica',
  naomi: 'Naomi',
  nisarga: 'Nisarga',
  reyansh: 'Reyansh',
  rishab: 'Rishabh',
  rishabh: 'Rishabh',
  rishikesh: 'Rishikesh',
  rudra: 'Rudra',
  sadhvi: 'Sadhvi',
  samridhi: 'Samridhi',
  'samridhi ghai': 'Samridhi',
  samvruth: 'Samvruth',
  sanjana: 'Sanjana',
  saoli: 'Saoli',
  soali: 'Saoli',
  shreya: 'Shreya',
  shubhi: 'Shubhi',
  shubi: 'Shubhi',
  shyam: 'Shyam',
  siddharth: 'Siddharth',
  sneha: 'Sneha',
  soheli: 'Soheli',
  'soheli tarafdar': 'Soheli',
  sourav: 'Sourav',
  sparsh: 'Sparsh',
  'sparsh tiwari': 'Sparsh',
  suryakant: 'Suryakant Das',
  'suryakant das': 'Suryakant Das',
  utsav: 'Utsav',
  yashaswee: 'Kunwar Yashaswee',
  'kunwar yashaswee': 'Kunwar Yashaswee',
  zaid: 'Zaid',
};

const EDITOR_ALIASES: Record<string, string> = {
  aadesh: 'Aadesh',
  afreen: 'Afreen',
  arundhoti: 'Arundhoti',
  harshita: 'Harshita Saxena',
  'harshita saxena': 'Harshita Saxena',
  jacob: 'Jacob Gijy',
  'jacob gijy': 'Jacob Gijy',
  joyita: 'Joyita',
  kaamna: 'Kaamna',
  kalp: 'Kalp',
  paras: 'Paras',
  rati: 'Rati',
  rishabh: 'Rishabh',
  rudra: 'Rudra',
  sagnik: 'Sagnik',
  sanjay: 'Sanjay',
  sayantan: 'Sayantan',
  shraabona: 'Shraabona',
  shubhi: 'Shubhi',
  siddharth: 'Siddharth',
  snehal: 'Snehal',
  soheli: 'Soheli',
  'soheli tarafdar': 'Soheli',
  supriya: 'Supriya',
  surjo: 'Surjo',
  suyash: 'Suyash',
  utsav: 'Utsav',
  zaid: 'Zaid',
};

const ALLOTTER_ALIASES: Record<string, string> = {
  insiya: 'Insiya Johar',
  'insiya johar': 'Insiya Johar',
  'kushal jain': 'Kushal Jain',
  'reyansh dubey': 'Reyansh Dubey',
  'samridhi ghai': 'Samridhi Ghai',
  'saurabh saket': 'Saurabh Saket',
  sparsh: 'Sparsh Tiwari',
  'sparsh tiwari': 'Sparsh Tiwari',
};

const STATUS_ALIASES: Record<string, string> = {
  'on hold': 'On Hold',
  'on-hold': 'On Hold',
  published: 'Published',
  publishing: 'Published',
  'pr published': 'Published (PR)',
  scheduled: 'Scheduled',
  'pr scheduled': 'Scheduled (PR)',
  submitted: 'Submitted',
  picked: 'Picked',
  'picked by reyansh': 'Picked',
  'send back': 'Sent Back',
  'sent back': 'Sent Back',
  sb: 'Sent Back',
  trashed: 'Trashed',
  scraped: 'Scrapped',
  scrapped: 'Scrapped',
  verified: 'Verified',
  verifying: 'Verifying',
  'moved to next day': 'Moved Forward',
  'moved forward': 'Moved Forward',
};

const JUNK_NAMES = new Set([
  'all articles to be added on the may sheet now',
  '3rd & 4 piece on michigan',
  'moved to next day',
  'realloting',
]);

function lookupAlias(value: string, map: Record<string, string>): string {
  const trimmed = value.trim();
  if (!trimmed) return 'Unknown';
  const key = trimmed.toLowerCase();
  return map[key] ?? trimmed;
}

// ── Public normalization functions ──

export function normalizeFeed(raw: string | null | undefined): string {
  if (!raw) return 'Unknown';
  return lookupAlias(raw, FEED_ALIASES);
}

export function normalizeWriter(raw: string | null | undefined): string {
  if (!raw) return 'Unknown';
  const trimmed = raw.trim();
  if (!trimmed) return 'Unknown';
  if (JUNK_NAMES.has(trimmed.toLowerCase())) return 'Unknown';
  return lookupAlias(trimmed, WRITER_ALIASES);
}

export function normalizeEditor(raw: string | null | undefined): string {
  if (!raw) return 'Unknown';
  const trimmed = raw.trim();
  if (!trimmed) return 'Unknown';
  return lookupAlias(trimmed, EDITOR_ALIASES);
}

export function normalizeAllotter(raw: string | null | undefined): string {
  if (!raw) return 'Unknown';
  return lookupAlias(raw, ALLOTTER_ALIASES);
}

export function normalizeStatus(raw: string | null | undefined): string {
  if (!raw) return 'Unknown';
  const cleaned = raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'Unknown';
  return lookupAlias(cleaned, STATUS_ALIASES);
}

export function normalizeContentType(raw: string | null | undefined): string {
  if (!raw) return 'Unknown';
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'news') return 'Article';
  if (lower === 'slideshows' || lower === 'slideshow') return 'Slideshow';
  if (lower === 'ss automation' || lower === 'ss auto') return 'SS Automation';
  if (lower === 'article') return 'Article';
  return trimmed;
}

export function normalizeCategory(raw: string | null | undefined): string {
  if (!raw) return 'Unknown';
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Unknown';
  return cleaned;
}

// ── Data cleaning: slides ──

export function parseSlides(raw: any): number | null {
  if (raw == null || raw === '' || raw === ' ') return null;

  const str = String(raw).trim();

  // Reject values that look like dates or timestamps
  if (/[\/\-]/.test(str) && /\d{1,2}[\/\-]\d{1,2}/.test(str)) return null;
  if (/\d{4}-\d{2}-\d{2}/.test(str)) return null;
  if (/[a-zA-Z]/.test(str)) return null;

  const n = Number(str);
  if (isNaN(n)) return null;

  // Sheets serial dates are typically > 40000; slides should be < 500
  if (n > 500 || n < 0) return null;

  // Reject fractional values that look like time decimals (e.g. 0.4375 = 10:30 AM)
  if (!Number.isInteger(n) && n < 1) return null;

  return Math.round(n);
}

// ── Data cleaning: dates ──

const REASONABLE_MIN = new Date('2020-01-01').getTime();
const REASONABLE_MAX = new Date('2030-01-01').getTime();

function isReasonableDate(d: Date): boolean {
  const t = d.getTime();
  return !isNaN(t) && t >= REASONABLE_MIN && t <= REASONABLE_MAX;
}

/**
 * Parse a date/time cell into a Date. The integrated sheet is authored in
 * DD/MM/YYYY (Indian) locale, so slash/dash/dot strings are interpreted
 * day-first. ISO strings and Sheets serial numbers are also supported.
 */
export function parseDateTime(raw: any): Date | null {
  if (raw == null || raw === '' || raw === ' ') return null;

  if (raw instanceof Date) {
    return isReasonableDate(raw) ? raw : null;
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    // ISO-8601 (YYYY-MM-DD[THH:mm...]) — unambiguous, parse directly.
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      const iso = new Date(trimmed);
      return isReasonableDate(iso) ? iso : null;
    }

    // DD/MM/YYYY [HH:mm[:ss]] — split date and optional time parts.
    const [datePart, ...timeParts] = trimmed.split(/[ T]/);
    const parts = datePart.split(/[\/\-.]/).map((p) => Number(p));
    if (parts.length === 3 && parts.every((n) => !isNaN(n))) {
      let [day, month, year] = parts;
      if (year < 100) year += 2000;

      // If "day" can't be a day but "month" can, the cell is MM/DD — swap.
      if (day > 31 && month <= 31) [day, month] = [month, day];
      else if (month > 12 && day <= 12) [day, month] = [month, day];

      let hh = 0;
      let mm = 0;
      let ss = 0;
      if (timeParts.length) {
        const t = timeParts.join(' ').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (t) {
          hh = Number(t[1]);
          mm = Number(t[2]);
          ss = Number(t[3] || 0);
        }
      }
      const attempt = new Date(year, month - 1, day, hh, mm, ss);
      if (isReasonableDate(attempt)) return attempt;
    }

    // Last resort: native parse.
    const d = new Date(trimmed);
    return isReasonableDate(d) ? d : null;
  }

  // Sheets serial number (date + fractional time).
  if (typeof raw === 'number') {
    if (raw < 30000 || raw > 55000) return null;
    const epoch = new Date(1899, 11, 30);
    const days = Math.floor(raw);
    const fraction = raw - days;
    epoch.setDate(epoch.getDate() + days);
    epoch.setMilliseconds(
      epoch.getMilliseconds() + Math.round(fraction * 86400000),
    );
    return isReasonableDate(epoch) ? epoch : null;
  }

  return null;
}

/** Date-only (YYYY-MM-DD) extraction from a parsed Date. */
export function toDateOnly(d: Date | null): string | null {
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Swap day↔month (preserving time). Null if the day can't be a month (>12). */
function swapDayMonth(d: Date): Date | null {
  const day = d.getDate();
  const month = d.getMonth() + 1;
  if (day > 12) return null; // already unambiguous — a month can't exceed 12
  const swapped = new Date(
    d.getFullYear(),
    day - 1,
    month,
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
  );
  return isReasonableDate(swapped) ? swapped : null;
}

/**
 * Repair DD/MM vs MM/DD confusion in one row's lifecycle timestamps using the
 * one signal that's safe and deterministic: a single piece's stamps cluster on
 * one calendar day, so an outlier that — once day/month-swapped — matches the
 * row's majority date was transposed at the source. Swap only those.
 *
 * NOTE: this intentionally does NOT do a wall-clock "future guard". The sheet is
 * now read as unformatted serial numbers (dateTimeRenderOption SERIAL_NUMBER),
 * so dates arrive unambiguous — there is no DD/MM string to misread. The old
 * guard swapped any timestamp that merely looked future at parse time, which
 * silently corrupted valid dates (e.g. a "July 3" piece synced while the clock
 * still read June became "March 7"), and because `date` is cached until a row's
 * raw hash changes, the bad value stuck. A genuine future stamp is left as-is.
 * Input/output are positional (lifecycle order); nulls pass through untouched.
 */
export function reconcileTimestamps(
  dates: (Date | null)[],
): (Date | null)[] {
  const out = dates.slice();

  // Intra-row consensus.
  const counts = new Map<string, number>();
  for (const d of out) {
    if (!d) continue;
    const k = toDateOnly(d)!;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let modal = '';
  let best = 0;
  for (const [k, n] of counts) {
    if (n > best) {
      best = n;
      modal = k;
    }
  }
  if (best >= 2) {
    for (let i = 0; i < out.length; i++) {
      const d = out[i];
      if (!d || toDateOnly(d) === modal) continue;
      const sw = swapDayMonth(d);
      if (sw && toDateOnly(sw) === modal) out[i] = sw;
    }
  }

  return out;
}

// ── Row hash for change detection ──

export function computeRowHash(values: any[]): string {
  const str = values.map((v) => (v == null ? '' : String(v).trim())).join('|');
  return crypto.createHash('md5').update(str).digest('hex');
}

/**
 * Normalize a title for cross-sheet matching: lowercase, collapse whitespace,
 * strip surrounding quotes and trailing punctuation. Keeps inner punctuation
 * so distinct titles stay distinct.
 */
export function normalizeTitleKey(title: string): string {
  return (title || '')
    .toLowerCase()
    .replace(/[‘’“”]/g, "'") // smart → straight quotes
    .replace(/\s+/g, ' ')
    .replace(/^["']+|["'.\s]+$/g, '')
    .trim();
}

// ── Row validation ──

export function isValidPiece(row: {
  id: string;
  feed: string;
  writer: string;
  title: string;
}): boolean {
  if (!row.id) return false;
  // A usable piece needs at least one identifying dimension.
  if (
    row.feed === 'Unknown' &&
    row.writer === 'Unknown' &&
    !row.title.trim()
  )
    return false;
  return true;
}
