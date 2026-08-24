import {
  format,
  lastDayOfMonth,
  parseISO,
  startOfMonth,
  subDays,
  subMonths,
} from 'date-fns';

/** One comparison window: a current span and the span it is measured against. */
export interface HeadlineWindow {
  start: string;
  end: string;
  prevStart: string;
  prevEnd: string;
}

export interface HeadlineWindows {
  /** The day every window is anchored on. */
  anchor: string;
  /** Anchor day vs the day before it. */
  dod: HeadlineWindow;
  /** Seven days ending on the anchor vs the seven before those. */
  wow: HeadlineWindow;
  /** Anchor month up to the anchor day vs the same span last month. */
  mtd: HeadlineWindow;
  /** Earliest date any window touches — the bound for a single SQL scan. */
  earliest: string;
}

const iso = (d: Date) => format(d, 'yyyy-MM-dd');

/**
 * The MTD / DOD / WOW spans behind the headline chips, anchored on a given day.
 *
 * Callers anchor on the newest day that has data rather than on yesterday: all
 * three feeds (BigQuery traffic, Meta snapshots, revenue) sync on a lag, and an
 * unsynced yesterday would otherwise report every metric as down 100%.
 */
export function buildHeadlineWindows(
  anchorDate: string | Date,
): HeadlineWindows {
  const anchor =
    typeof anchorDate === 'string' ? parseISO(anchorDate) : anchorDate;

  const prevDay = subDays(anchor, 1);
  const weekStart = subDays(anchor, 6);
  const prevWeekEnd = subDays(anchor, 7);
  const prevWeekStart = subDays(anchor, 13);

  const monthStart = startOfMonth(anchor);
  const prevMonthStart = startOfMonth(subMonths(anchor, 1));
  // Clamp the day of month, so 31 Mar compares against 28/29 Feb rather than
  // spilling into March.
  const prevMonthEnd = new Date(
    prevMonthStart.getFullYear(),
    prevMonthStart.getMonth(),
    Math.min(anchor.getDate(), lastDayOfMonth(prevMonthStart).getDate()),
  );

  return {
    anchor: iso(anchor),
    dod: {
      start: iso(anchor),
      end: iso(anchor),
      prevStart: iso(prevDay),
      prevEnd: iso(prevDay),
    },
    wow: {
      start: iso(weekStart),
      end: iso(anchor),
      prevStart: iso(prevWeekStart),
      prevEnd: iso(prevWeekEnd),
    },
    mtd: {
      start: iso(monthStart),
      end: iso(anchor),
      prevStart: iso(prevMonthStart),
      prevEnd: iso(prevMonthEnd),
    },
    earliest: iso(
      prevMonthStart < prevWeekStart ? prevMonthStart : prevWeekStart,
    ),
  };
}

/** Percent change, with no baseline reported as null so the UI can say "new". */
export function percentChange(
  current: number,
  previous: number,
): number | null {
  if (previous > 0)
    return Number((((current - previous) / previous) * 100).toFixed(2));
  return current > 0 ? null : 0;
}

/** A window plus the two numbers measured over it, as the API returns it. */
export function windowResult(
  window: HeadlineWindow,
  value: number,
  prevValue: number,
) {
  return {
    ...window,
    value,
    prevValue,
    diff: percentChange(value, prevValue),
  };
}
