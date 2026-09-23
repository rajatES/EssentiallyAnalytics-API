// Resource board shapes. People come from the Dynamic Schedule workbook (via
// the aggregate sheet's People tab); their work is counted across Critical
// Flow and Yahoo.

export type ResourceStatus =
  | 'Off'
  | 'Free'
  | 'Available'
  | 'At capacity'
  | 'Overloaded'
  | 'Busy';

export interface ResourceLeave {
  from: string;
  to: string;
  type: string;
}

export interface ResourcePerson {
  /** `${primaryDivision}|${name}` — stable across requests, used for profiles. */
  key: string;
  name: string;
  primaryDivision: string;
  subFeed: string;
  /** Explicit, from the schedule workbook. */
  secondaryDivisions: string[];
  /** Inferred from content: every division they have a piece in. */
  workedDivisions: { division: string; pieces: number }[];
  role: string;
  roleGroup: string;
  pod: string;
  shift: string;
  shiftClock: string;
  weekoff: string;
  status: ResourceStatus;
  statusReason: string;
  offToday: boolean;
  /** "Weekly off" | "Scheduled off" | "On leave (Sick) until 2026-09-16" | '' */
  offReason: string;
  onLeave: ResourceLeave | null;
  /** Who the schedule says covers them today, if off. */
  coveredBy: string;
  /** Standing backup from Editor Info. */
  backup: string;
  /** Writers: submitted today. Editors: published today. Both pipelines. */
  doneToday: number;
  /** The part of doneToday that went through the Yahoo sheet. */
  doneYahoo: number;
  /** Editors only: pieces they verified today, as a secondary output signal. */
  verifiedToday: number;
  quota: number | null;
  /** Writers: allotted + sent back, not yet submitted. */
  inFlight: number;
  /** Editors: pieces awaiting their editorial pass. */
  queue: number;
  /** The part of inFlight (writers) or queue (editors) on the Yahoo sheet. */
  loadYahoo: number;
  /** quota − done − inFlight, or null without a quota. */
  remaining: number | null;
  /** Pieces with no timestamps at all — output that cannot be dated. */
  undatedPieces: number;
  lastActive: string | null;
  /** schedule | content */
  sources: string[];
  flags: string[];
  /** Active | On notice | Exited | '' from Roles & Contact. */
  employment: string;
  notes: string;
}

export interface ResourceBoardResult {
  date: string;
  weekday: string;
  currentShift: string;
  people: ResourcePerson[];
  counts: Record<ResourceStatus, number>;
}

export interface SubFeedProgress {
  subFeed: string;
  quota: number;
  submitted: number;
}

export interface DivisionResourceSummary {
  division: string;
  poc: string;
  architecture: string;
  quotaEmp: number;
  quotaLnp: number;
  quotaTotal: number;
  /** True when the workbook never gives this division a quota. */
  quotaMissing: boolean;
  /** Editorial Chart figure when it disagrees with DailyDynamics, else null. */
  quotaConflict: number | null;
  /** Critical Flow submissions, measured against the DailyDynamics quota. */
  submittedEmp: number;
  submittedLnp: number;
  submittedTotal: number;
  publishedToday: number;
  /** Shortfall against the shift currently running. */
  gapCurrentShift: number;
  /** Shortfall against the whole day. */
  gapDay: number;
  /** Yahoo's own daily quota for this division, when its sheet sets one. */
  yahooQuota: number | null;
  yahooSubmitted: number;
  yahooPublished: number;
  /** Both pipelines. */
  awaitingEditorial: number;
  awaitingSubmission: number;
  unassignedEditorial: number;
  openSendBacks: number;
  writersTotal: number;
  writersOff: number;
  writersFree: number;
  writersAvailable: number;
  editorsTotal: number;
  editorsOff: number;
  editorsFree: number;
  undatedPieces: number;
  subFeeds: SubFeedProgress[];
}

export interface ResourceSummaryResult {
  date: string;
  weekday: string;
  currentShift: string;
  divisions: DivisionResourceSummary[];
  totals: {
    quota: number;
    submitted: number;
    published: number;
    gapDay: number;
    yahooPublished: number;
    awaitingEditorial: number;
    writersFree: number;
    editorsFree: number;
    onLeave: number;
  };
}

export interface SuggestCandidate {
  person: ResourcePerson;
  score: number;
  reasons: string[];
}

export interface SuggestResult {
  date: string;
  division: string;
  role: string;
  forPerson: string | null;
  candidates: SuggestCandidate[];
}

export interface ResourceProfile {
  key: string;
  division: string;
  name: string;
  dailyQuota: number | null;
  notes: string;
  updatedAt: string | null;
}

export interface ScheduleHealthFlag {
  issue: string;
  count: number;
  detail: string;
  items: string[];
}

export interface ScheduleHealthResult {
  /** A spreadsheet id is configured for the People / Leaves / Quotas tabs. */
  sheetConfigured: boolean;
  lastSyncTime: string | null;
  syncError: string | null;
  people: number;
  leaves: number;
  quotas: number;
  flags: ScheduleHealthFlag[];
}

export interface ResourcesSyncStatus {
  sheetConfigured: boolean;
  lastSyncTime: string | null;
  syncing: boolean;
  error: string | null;
}
