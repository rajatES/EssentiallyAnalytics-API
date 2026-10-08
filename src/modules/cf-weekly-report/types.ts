// The Critical Flow weekly efficiency report, computed from the production the
// desk already tracks: each group's output per person per day worked, week on
// week, Monday to Sunday.

export interface ReportWeek {
  start: string;
  end: string;
}

/** One person, or one group, in one week. */
export interface WeekTally {
  /** Pieces submitted (writers) or published (editors). */
  output: number;
  /** Person-days with any output. */
  daysWorked: number;
  /** People with any output; 1 or 0 for a single person. */
  active: number;
  /** output ÷ daysWorked, or null when nobody worked. */
  perDay: number | null;
}

export interface ReportMember {
  name: string;
  division: string;
  role: string;
  weeks: WeekTally[];
}

export interface ReportGroup {
  name: string;
  /** What a member's output is: what they submitted, or what they published. */
  measure: 'submitted' | 'published' | 'by role';
  /** The desk's "ideal efficiency": output per person per day; null for writers on no schedule. */
  target: number | null;
  /** Listed in the schedule today, active or not. */
  rostered: number;
  weeks: WeekTally[];
  members: ReportMember[];
}

export interface ReportSection {
  title: string;
  groups: ReportGroup[];
}

export interface WeeklyReport {
  /** Oldest first; the last is the week the report is "as of". */
  weeks: ReportWeek[];
  /** End of the latest complete week, the furthest the report can move forward to. */
  latestEnd: string;
  sections: ReportSection[];
}
