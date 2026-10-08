// The Critical Flow weekly efficiency report, computed from the production the
// desk already tracks: each group's output per person per day worked, week on
// week, Monday to Sunday.

export interface ReportWeek {
  start: string;
  end: string;
}

/** One person, or one group, in one week. */
export interface WeekTally {
  /** Pieces submitted (writers), published (editors) or written (editors' own). */
  output: number;
  /** Person-days with any output; a full week per person for editors' own writing. */
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

export type GroupKey =
  | 'stables'
  | 'part-time'
  | 'msn'
  | 'tenured'
  | 'editors'
  | 'producers'
  | 'pod'
  | 'non-pod'
  | 'associates'
  | 'stables-editors'
  | 'unlisted';

export interface ReportGroup {
  key: GroupKey;
  name: string;
  /**
   * What a member's output is: what they submitted, what they published, by
   * role for producers, or what editors wrote themselves over the whole week.
   */
  measure: 'submitted' | 'published' | 'by role' | 'written';
  /** The desk's "ideal efficiency": output per person per day; null where the sheet sets none. */
  target: number | null;
  /** Listed in the schedule today, active or not. */
  rostered: number;
  /** Rostered members on leave for the whole of the latest week. */
  onLeave: number;
  /** Primary divisions of the rostered members, most members first. */
  divisions: string[];
  weeks: WeekTally[];
  members: ReportMember[];
}

export interface WeeklyReport {
  /** Oldest first; the last is the week the report is "as of". */
  weeks: ReportWeek[];
  /** End of the latest complete week, the furthest the report can move forward to. */
  latestEnd: string;
  /** In the order of the desk's Week on Week sheet. */
  groups: ReportGroup[];
}
