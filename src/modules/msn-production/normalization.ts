import * as crypto from 'crypto';

// ── Alias maps ──

const FEED_ALIASES: Record<string, string> = {
  'bengals': 'Bengals',
  'broncos': 'Broncos',
  'browns': 'Browns',
  'chiefs': 'Chiefs',
  'kcc': 'Chiefs',
  'kansas city huddle': 'Chiefs',
  'cowboys': 'Cowboys',
  'dallas cowboys': 'Cowboys',
  'lions': 'Lions',
  'michigan': 'Michigan',
  'wolverines': 'Michigan',
  'qb central': 'QB Central',
  'qbc': 'QB Central',
  'qbcentral': 'QB Central',
  'quarterback central': 'QB Central',
  'quaterback central': 'QB Central',
};

const WRITER_ALIASES: Record<string, string> = {
  'aaindri': 'Aaindri',
  'aaindri thakuri': 'Aaindri',
  'aindri thakuri': 'Aaindri',
  'aadinri': 'Aaindri',
  'aaradhya': 'Aaradhya',
  'aradhya': 'Aaradhya',
  'aaron': 'Aaron',
  'abhay': 'Abhay',
  'akanksha': 'Akansha',
  'akansha': 'Akansha',
  'aknaksha': 'Akansha',
  'anjali': 'Anjali',
  'ankita': 'Ankita',
  'anshuman': 'Anshuman',
  'anugya': 'Anugya',
  'apeksha': 'Apeksha',
  'archana': 'Archana',
  'arijit': 'Arijit',
  'arjit': 'Arijit',
  'arundhoti': 'Arundhoti',
  'darshan': 'Darshanbir',
  'darshanbir': 'Darshanbir',
  'debanjali': 'Debanjali',
  'devyanshi': 'Divyanshi',
  'divyanshi': 'Divyanshi',
  'dheeraj': 'Dheeraj',
  'dhruv': 'Dhruv',
  'eklavya': 'Eklavya',
  'evince': 'Evince',
  'farheen': 'Farheen',
  'hetal': 'Hetal',
  'insiya': 'Insiya Johar',
  'insiya johar': 'Insiya Johar',
  'manoj': 'Manoj',
  'maria': 'Maria',
  'monica': 'Monica',
  'monika': 'Monica',
  'naomi': 'Naomi',
  'nisarga': 'Nisarga',
  'reyansh': 'Reyansh',
  'rishab': 'Rishabh',
  'rishabh': 'Rishabh',
  'rishikesh': 'Rishikesh',
  'rudra': 'Rudra',
  'sadhvi': 'Sadhvi',
  'samridhi': 'Samridhi',
  'samridhi ghai': 'Samridhi',
  'samvruth': 'Samvruth',
  'sanjana': 'Sanjana',
  'saoli': 'Saoli',
  'soali': 'Saoli',
  'shreya': 'Shreya',
  'shubhi': 'Shubhi',
  'shubi': 'Shubhi',
  'shyam': 'Shyam',
  'siddharth': 'Siddharth',
  'sneha': 'Sneha',
  'soheli': 'Soheli',
  'soheli tarafdar': 'Soheli',
  'sourav': 'Sourav',
  'sparsh': 'Sparsh',
  'sparsh tiwari': 'Sparsh',
  'suryakant': 'Suryakant',
  'utsav': 'Utsav',
  'yashaswee': 'Yashaswee',
  'zaid': 'Zaid',
};

const EDITOR_ALIASES: Record<string, string> = {
  'aadesh': 'Aadesh',
  'afreen': 'Afreen',
  'arundhoti': 'Arundhoti',
  'harshita': 'Harshita',
  'jacob': 'Jacob',
  'joyita': 'Joyita',
  'kaamna': 'Kaamna',
  'kalp': 'Kalp',
  'paras': 'Paras',
  'rati': 'Rati',
  'rishabh': 'Rishabh',
  'rudra': 'Rudra',
  'sagnik': 'Sagnik',
  'sanjay': 'Sanjay',
  'sayantan': 'Sayantan',
  'shraabona': 'Shraabona',
  'shubhi': 'Shubhi',
  'siddharth': 'Siddharth',
  'snehal': 'Snehal',
  'soheli': 'Soheli',
  'soheli tarafdar': 'Soheli',
  'supriya': 'Supriya',
  'surjo': 'Surjo',
  'suyash': 'Suyash',
  'utsav': 'Utsav',
  'zaid': 'Zaid',
};

const ALLOTTER_ALIASES: Record<string, string> = {
  'insiya': 'Insiya Johar',
  'insiya johar': 'Insiya Johar',
  'kushal jain': 'Kushal Jain',
  'reyansh dubey': 'Reyansh Dubey',
  'samridhi ghai': 'Samridhi Ghai',
  'saurabh saket': 'Saurabh Saket',
  'sparsh': 'Sparsh Tiwari',
  'sparsh tiwari': 'Sparsh Tiwari',
};

const STATUS_ALIASES: Record<string, string> = {
  'on hold': 'On Hold',
  'published': 'Published',
  'publishing': 'Published',
  'pr published': 'Published (PR)',
  'scheduled': 'Scheduled',
  'pr scheduled': 'Scheduled (PR)',
  'submitted': 'Submitted',
  'picked': 'Picked',
  'picked by reyansh': 'Picked',
  'send back': 'Sent Back',
  'sent back': 'Sent Back',
  'sb': 'Sent Back',
  'trashed': 'Trashed',
  'scraped': 'Scrapped',
  'scrapped': 'Scrapped',
  'verified': 'Verified',
  'verifying': 'Verifying',
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
  const cleaned = raw.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
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

export function parseSheetsDate(raw: any): string | null {
  if (raw == null || raw === '' || raw === ' ') return null;

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    // Try direct parse
    const d = new Date(trimmed);
    if (isReasonableDate(d)) return d.toISOString().split('T')[0];

    // Try DD/MM/YYYY or DD-MM-YYYY format
    const parts = trimmed.split(/[\/\-\.]/);
    if (parts.length === 3) {
      const [a, b, c] = parts.map(Number);
      if (c > 1000) {
        // a/b/c where c is year
        const attempt = new Date(c, b - 1, a);
        if (isReasonableDate(attempt)) return attempt.toISOString().split('T')[0];
      }
    }

    return null;
  }

  // Sheets serial date number
  if (typeof raw === 'number') {
    // Valid date serials: ~43831 (2020-01-01) to ~47482 (2030-01-01)
    if (raw < 30000 || raw > 55000) return null;
    const epoch = new Date(1899, 11, 30);
    epoch.setDate(epoch.getDate() + Math.floor(raw));
    if (isReasonableDate(epoch)) return epoch.toISOString().split('T')[0];
    return null;
  }

  return null;
}

export function parseSheetsTimestamp(raw: any): Date | null {
  if (raw == null || raw === '' || raw === ' ') return null;

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const d = new Date(trimmed);
    if (isReasonableDate(d)) return d;
    return null;
  }

  if (typeof raw === 'number') {
    if (raw < 30000 || raw > 55000) return null;
    const epoch = new Date(1899, 11, 30);
    const days = Math.floor(raw);
    const fraction = raw - days;
    epoch.setDate(epoch.getDate() + days);
    epoch.setMilliseconds(epoch.getMilliseconds() + Math.round(fraction * 86400000));
    if (isReasonableDate(epoch)) return epoch;
    return null;
  }

  return null;
}

// ── Row hash for change detection ──

export function computeRowHash(values: any[]): string {
  const str = values.map((v) => (v == null ? '' : String(v).trim())).join('|');
  return crypto.createHash('md5').update(str).digest('hex');
}

// ── Row validation ──

export function isValidSourceRow(row: {
  rowId: string;
  brand: string;
  contentType: string;
  feed: string;
  writer: string;
}): boolean {
  if (!row.rowId) return false;
  if (!row.brand || row.brand === 'Unknown') return false;
  if (row.contentType === 'Unknown') return false;
  if (row.feed === 'Unknown' && row.writer === 'Unknown') return false;
  return true;
}

export function isValidAllotmentRow(row: {
  brand: string;
  feed: string;
  writer: string;
}): boolean {
  if (!row.brand || row.brand === 'Unknown') return false;
  if (row.feed === 'Unknown' && row.writer === 'Unknown') return false;
  return true;
}
