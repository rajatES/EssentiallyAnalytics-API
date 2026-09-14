// Shared result shapes for the Critical Flow module. The UI mirrors this file
// at src/features/critical-flow/types.ts — keep the two in step.

export interface CfFilterParams {
  startDate?: string;
  endDate?: string;
  divisions?: string[];
  writers?: string[];
  editors?: string[];
  articleTypes?: string[];
  statuses?: string[];
  allotters?: string[];
  /** 'yahoo' | 'non-yahoo' | undefined (both) */
  yahoo?: string;
}

export interface ParsedPiece {
  id: string;
  uniquePieceId: string;
  division: string;
  month: string;
  writer: string;
  editor: string;
  editor2: string;
  allottedBy: string;
  articleType: string;
  yahoo: boolean | null;
  editorialStatus: string;
  editorialStatus2: string;
  sbReason: string;
  wpStatus: string;
  allottedAt: Date | null;
  submittedAt: Date | null;
  submittedEst: Date | null;
  editorAt: Date | null;
  editorAt2: Date | null;
  liveAt: Date | null;
  wpCheckedAt: Date | null;
  publishedDate: string | null;
  date: string | null;
  tatHours: number | null;
  sbHours: number | null;
  title: string;
  titleNorm: string;
  source: string;
  stagingLink: string;
  writerComments: string;
  editorComment: string;
  editorComment2: string;
  articleMap: string;
  plagReport: string;
  rawHash: string;
}

export interface ParsedRosterPerson {
  id: string;
  division: string;
  name: string;
  role: string;
  roleGroup: string;
  weekoff: string;
  shift: string;
  email: string;
  dailyTarget: number | null;
  rawHash: string;
}

export interface SyncStatus {
  lastSyncTime: string | null;
  rowCount: number;
  rosterCount: number;
  syncing: boolean;
  error: string | null;
}

export interface FilterOptions {
  divisions: string[];
  writers: string[];
  editors: string[];
  articleTypes: string[];
  statuses: string[];
  allotters: string[];
  sbReasons: string[];
  dateRange: { min: string; max: string };
}

export interface KpiDelta {
  value: number;
  pct: number | null;
}

export interface KpiOverview {
  allotted: number;
  submitted: number;
  verified: number;
  published: number;
  /** published / allotted */
  publishRate: number;
  /** submitted / allotted */
  submissionRate: number;
  /** pieces sent back at least once, as a share of those that reached editorial */
  sendBackRate: number;
  medianTatHours: number;
  p90TatHours: number;
  yahooCount: number;
  yahooShare: number;
  pendingCount: number;
  activeWriters: number;
  activeEditors: number;
  perWriterPerDay: number;
  /** False when no date range was supplied, so deltas carry no comparison. */
  deltasAvailable: boolean;
  deltas: Record<string, KpiDelta>;
}

export interface TimeseriesBucket {
  bucket: string;
  allotted: number;
  submitted: number;
  verified: number;
  published: number;
  sentBack: number;
  yahoo: number;
  nonYahoo: number;
  medianTatHours: number;
}

export interface FunnelStage {
  stage: string;
  count: number;
  /** share of the stage before it */
  conversion: number;
  dropped: number;
}

export interface PendingItem {
  id: string;
  division: string;
  stage: string;
  pendingWith: string;
  title: string;
  stagingLink: string;
  waitingSince: string | null;
  ageingHours: number;
}

export interface PendingBucket {
  stage: string;
  count: number;
  medianAgeHours: number;
  oldestAgeHours: number;
}

export interface PendingResult {
  buckets: PendingBucket[];
  byDivision: { division: string; awaitingSubmission: number; awaitingEditorial: number; awaitingLive: number; total: number }[];
  ageBands: { band: string; count: number }[];
  items: PendingItem[];
}

export interface WriterStats {
  writer: string;
  division: string;
  allotted: number;
  submitted: number;
  verified: number;
  published: number;
  sentBack: number;
  sendBackRate: number;
  yahoo: number;
  nonYahoo: number;
  medianTatHours: number;
  /** Null where allotment carries no clock time, making the leg unmeasurable. */
  medianWriteHours: number | null;
  submissionRate: number;
  pending: number;
}

export interface EditorStats {
  editor: string;
  division: string;
  handled: number;
  verified: number;
  sentBack: number;
  sendBackRate: number;
  secondPass: number;
  yahoo: number;
  nonYahoo: number;
  medianReviewHours: number | null;
}

export interface AllotterStats {
  allotter: string;
  division: string;
  allotted: number;
  submitted: number;
  published: number;
  submissionRate: number;
  neverPicked: number;
}

export interface SendBackEntry {
  reason: string;
  count: number;
  share: number;
  medianReworkHours: number | null;
}

export interface SendBackResult {
  total: number;
  rate: number;
  reasons: SendBackEntry[];
  byEditor: { editor: string; sentBack: number; handled: number; rate: number }[];
  byWriter: { writer: string; sentBack: number; submitted: number; rate: number }[];
  byDivision: { division: string; sentBack: number; handled: number; rate: number }[];
  trend: { bucket: string; sentBack: number; handled: number; rate: number }[];
  /** Pieces sent back and still not re-verified. */
  openSendBacks: PendingItem[];
}

export interface TatStat {
  label: string;
  count: number;
  median: number;
  p90: number;
  max: number;
}

export interface TatResult {
  overall: TatStat;
  distribution: { band: string; count: number }[];
  byDivision: TatStat[];
  byArticleType: TatStat[];
  byWriter: TatStat[];
  byEditor: TatStat[];
  /** Median hours in each leg; null where the source lacks the timestamps. */
  stages: { stage: string; median: number | null; p90: number | null; count: number }[];
  slowest: {
    id: string;
    division: string;
    title: string;
    writer: string;
    editor: string;
    tatHours: number;
    stagingLink: string;
  }[];
}

export interface DivisionStats {
  division: string;
  allotted: number;
  submitted: number;
  verified: number;
  published: number;
  sentBack: number;
  pending: number;
  yahoo: number;
  yahooShare: number;
  publishRate: number;
  medianTatHours: number;
  writers: number;
  editors: number;
}

export interface ArticleTypeEntry {
  articleType: string;
  count: number;
  share: number;
  published: number;
  sentBack: number;
  medianTatHours: number;
  yahoo: number;
}

export interface YahooSplitResult {
  yahoo: { count: number; published: number; medianTatHours: number; sendBackRate: number };
  nonYahoo: { count: number; published: number; medianTatHours: number; sendBackRate: number };
  unset: number;
  byDivision: { division: string; yahoo: number; nonYahoo: number; unset: number; yahooShare: number }[];
  trend: { bucket: string; yahoo: number; nonYahoo: number }[];
}

export interface RosterEntry {
  id: string;
  division: string;
  name: string;
  role: string;
  roleGroup: string;
  weekoff: string;
  shift: string;
  email: string;
  dailyTarget: number | null;
  /** Whether today is this person's week-off. */
  offToday: boolean;
  /** Pieces currently in flight with this person. */
  activePieces: number;
  lastActiveDate: string | null;
}

export interface RosterResult {
  people: RosterEntry[];
  byDivision: { division: string; total: number; writers: number; editors: number; offToday: number }[];
  /** Rostered people with no activity in the selected window. */
  idle: { name: string; division: string; role: string; lastActiveDate: string | null; daysIdle: number | null }[];
  /** Names appearing in the data but absent from every roster. */
  unrostered: { name: string; division: string; role: string; pieces: number }[];
  /** Names in the log that may be one person split across divisions. */
  nameVariants: { variants: { name: string; division: string; pieces: number }[] }[];
}

export interface InsightsResult {
  weekdayRhythm: { weekday: string; allotted: number; submitted: number; published: number; medianTatHours: number }[];
  submissionHeatmap: { weekday: number; hour: number; count: number }[];
  stuck: PendingItem[];
  duplicates: {
    titleNorm: string;
    title: string;
    count: number;
    divisions: string[];
    writers: string[];
    ids: string[];
  }[];
  dataQuality: { issue: string; count: number; detail: string }[];
}

// ── Schedule workbook (parsed shapes) ──

export interface ParsedSchedulePerson {
  id: string;
  name: string;
  primaryDivision: string;
  subFeed: string;
  secondaryDivisions: string[];
  role: string;
  roleGroup: string;
  pod: string;
  shift: string;
  shiftClock: string;
  weekoff: string;
  weekPlan: string;
  backup: string;
  status: string;
  sources: string;
  flags: string;
  rawHash: string;
}

export interface ParsedLeave {
  id: string;
  name: string;
  roleTag: string;
  leaveStart: string;
  leaveEnd: string;
  days: number | null;
  type: string;
  loggedAt: Date | null;
  rawHash: string;
}

export interface ParsedDivisionQuota {
  id: string;
  division: string;
  subFeed: string;
  sourceName: string;
  emp: number;
  lnp: number;
  total: number;
  editorialChartTotal: number | null;
  poc: string;
  architecture: string;
  rawHash: string;
}

export interface ScheduleSyncResult {
  people: ParsedSchedulePerson[];
  leaves: ParsedLeave[];
  quotas: ParsedDivisionQuota[];
}

// ── Resources page ──

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
  /** Writers: submitted today. Editors: published today. */
  doneToday: number;
  /** Editors only: pieces they verified today, as a secondary output signal. */
  verifiedToday: number;
  quota: number | null;
  /** Writers: allotted + sent back, not yet submitted. */
  inFlight: number;
  /** Editors: pieces awaiting their editorial pass. */
  queue: number;
  /** quota − done − inFlight, or null without a quota. */
  remaining: number | null;
  /** Pieces with no timestamps at all — output that cannot be dated. */
  undatedPieces: number;
  lastActive: string | null;
  email: string;
  /** Which sheets list this person: schedule | roster | content. */
  sources: string[];
  flags: string[];
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
  submittedEmp: number;
  submittedLnp: number;
  submittedTotal: number;
  publishedToday: number;
  /** Shortfall against the shift currently running. */
  gapCurrentShift: number;
  /** Shortfall against the whole day. */
  gapDay: number;
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
  scheduleSheetConfigured: boolean;
  people: number;
  leaves: number;
  quotas: number;
  flags: ScheduleHealthFlag[];
}
