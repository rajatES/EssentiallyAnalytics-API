import { opsDayOf } from './time';

/**
 * Pure statistics and bucketing shared by every production dashboard. Nothing
 * in here touches a repository, so it can be unit-tested and replayed against
 * fixtures without a database.
 */

/** Age bands (hours) used for the pending board. */
export const AGE_BANDS: [string, number, number][] = [
  ['< 4h', 0, 4],
  ['4–12h', 4, 12],
  ['12–24h', 12, 24],
  ['1–3d', 24, 72],
  ['3–7d', 72, 168],
  ['> 7d', 168, Infinity],
];

export const TAT_BANDS: [string, number, number][] = [
  ['< 1h', 0, 1],
  ['1–2h', 1, 2],
  ['2–4h', 2, 4],
  ['4–8h', 4, 8],
  ['8–24h', 8, 24],
  ['1–3d', 24, 72],
  ['> 3d', 72, Infinity],
];

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export function hoursBetween(
  from: Date | null | undefined,
  to: Date | null | undefined,
  capHours = 24 * 60,
): number | null {
  if (!from || !to) return null;
  const diff = (new Date(to).getTime() - new Date(from).getTime()) / 3600000;
  if (diff < 0 || diff > capHours) return null;
  return diff;
}

export function round(n: number, dp = 1): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

/**
 * Median, or null when there is nothing to average. Used wherever a 0 would be
 * read as "instant" rather than "not measurable" — several source columns are
 * only sporadically filled in, and a fake 0 there is worse than a blank.
 */
export function medianOrNull(values: number[]): number | null {
  return values.length ? median(values) : null;
}

/**
 * Arithmetic mean. Reported beside every median because the two only disagree
 * when a handful of pieces ran long — and that gap is the thing worth seeing.
 */
export function mean(values: number[]): number {
  if (!values.length) return 0;
  return round(values.reduce((a, b) => a + b, 0) / values.length);
}

export function meanOrNull(values: number[]): number | null {
  return values.length ? mean(values) : null;
}

/**
 * Distinct desk days present in a set of rows, by the given stamp. A timestamp
 * counts toward its desk day — IST, with 00:00–03:59 belonging to the night
 * shift that began the evening before — so one LNP shift that runs past
 * midnight is one day worked, not two. Date strings are already days.
 */
export function activeDayCount<T>(
  rows: T[],
  pick: (p: T) => Date | string | null | undefined,
): number {
  const days = new Set<string>();
  for (const r of rows) {
    const v = pick(r);
    if (!v) continue;
    days.add(typeof v === 'string' ? v.slice(0, 10) : opsDayOf(new Date(v)));
  }
  return days.size;
}

export function perDay(total: number, days: number): number {
  return days > 0 ? round(total / days, 2) : 0;
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
}

export function percentileOrNull(values: number[], p: number): number | null {
  return values.length ? percentile(values, p) : null;
}

export function pct(part: number, whole: number): number {
  return whole > 0 ? round((part / whole) * 100) : 0;
}

export function band(value: number, bands: [string, number, number][]): string {
  for (const [label, lo, hi] of bands) if (value >= lo && value < hi) return label;
  return bands[bands.length - 1][0];
}
