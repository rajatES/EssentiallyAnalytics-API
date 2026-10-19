// The Critical Flow weekly efficiency report, computed from the production the
// desk already tracks: each group's output per person per day worked, week on
// week, Monday to Sunday. Groups come from the Team Structure tab.

export interface ReportWeek {
  start: string;
  end: string;
  /** The week in progress: counted up to `through` (today), not to `end`. */
  partial: boolean;
  through: string;
}

/** One person, or one group, in one week. */
export interface WeekTally {
  /** Pieces submitted (writers, producers, editors' own writing) or published (editors). */
  output: number;
  /** Person-days with any output. */
  daysWorked: number;
  /** People with any output; 1 or 0 for a single person. */
  active: number;
  /**
   * A person's output ÷ their days worked; for a group, the mean of its active
   * members' figures (each person counts once, however many days they worked).
   * Null when nobody worked.
   */
  perDay: number | null;
}

export interface ReportMember {
  name: string;
  division: string;
  role: string;
  /** False for someone outside the group's roster who still had output. */
  rostered: boolean;
  weeks: WeekTally[];
}

export type GroupKey =
  | 'stables'
  | 'part-time'
  | 'tenured'
  | 'editors'
  | 'associate-editors'
  | 'newsroom'
  | 'producers'
  | 'associates'
  | 'pod'
  | 'non-pod'
  | 'unlisted';

export interface ReportGroup {
  key: GroupKey;
  name: string;
  /** What a member's output is: what they submitted, what they published, or what editors wrote themselves. */
  measure: 'submitted' | 'published' | 'written';
  /** The desk's "ideal efficiency": output per person per day; null where none is set. */
  target: number | null;
  /** On Team Structure in this group, active or not. */
  rostered: number;
  /** Primary divisions of the rostered members, most members first. */
  divisions: string[];
  weeks: WeekTally[];
  members: ReportMember[];
}

export interface WeeklyReport {
  /** Oldest first; the last is the week the report is "as of". */
  weeks: ReportWeek[];
  /** End of the week in progress, the furthest the report can move forward to. */
  latestEnd: string;
  /** End of the latest complete week. */
  lastCompleteEnd: string;
  /** In the order of the desk's Week on Week sheet. */
  groups: ReportGroup[];
}
