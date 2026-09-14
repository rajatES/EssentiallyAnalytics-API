/**
 * Calendar and shift arithmetic for the Critical Flow desk.
 *
 * Every timestamp in the source sheets is IST wall-clock (the workbooks are
 * set to Asia/Calcutta), and the desk's day is defined in IST regardless of
 * where the API happens to run, so all "today" / "which shift" questions are
 * answered here against that zone explicitly.
 */

export const DESK_TZ = 'Asia/Kolkata';

export type Shift = 'EMP' | 'LNP' | 'REG';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: DESK_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  weekday: 'short',
});

const WD_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function istParts(d: Date): Parts {
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: p.hour === '24' ? 0 : Number(p.hour),
    minute: Number(p.minute),
    weekday: WD_INDEX[p.weekday] ?? 0,
  };
}

/** YYYY-MM-DD of the instant in IST. */
export function istDate(d: Date): string {
  const p = istParts(d);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function istHour(d: Date): number {
  return istParts(d).hour;
}

export function todayIst(now = new Date()): string {
  return istDate(now);
}

/** "Monday", … for a YYYY-MM-DD desk date. */
export function weekdayNameOf(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Noon UTC keeps the civil date stable in every zone we could be running in.
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()];
}

export function shiftDate(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Which shift an IST hour belongs to. The desk runs an early (EMP) and a late
 * (LNP) shift; the LNP shift runs past midnight, and the hours 00:00–03:59
 * belong to the LNP shift that *started the previous evening*. Hours 04:00–16:59
 * are EMP (the "Regular" mid-day hours are folded into it for quota purposes,
 * since the quotas only exist as EMP/LNP).
 */
export function shiftOfHour(hour: number): Shift {
  if (hour >= 4 && hour < 17) return 'EMP';
  return 'LNP';
}

export function shiftOf(d: Date): Shift {
  return shiftOfHour(istHour(d));
}

/**
 * The desk day a timestamp counts toward. Same as its IST calendar date except
 * in the small hours, which roll back onto the LNP shift they belong to.
 */
export function opsDayOf(d: Date): string {
  const p = istParts(d);
  const cal = istDate(d);
  return p.hour < 4 ? shiftDate(cal, -1) : cal;
}

/** Shift in progress right now, for "how far through today's quota are we". */
export function currentShift(now = new Date()): Shift {
  return shiftOf(now);
}

/** Inclusive date-range membership on YYYY-MM-DD strings. */
export function dateWithin(date: string, from: string | null, to: string | null): boolean {
  if (!from) return false;
  const end = to || from;
  return date >= from && date <= end;
}
