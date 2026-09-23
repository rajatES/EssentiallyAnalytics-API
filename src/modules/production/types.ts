// Result shapes shared by every production dashboard (Critical Flow, Yahoo).
// The UI mirrors these at src/features/<page>/types.ts — keep them in step.

export interface ProductionFilterParams {
  startDate?: string;
  endDate?: string;
  divisions?: string[];
  writers?: string[];
  editors?: string[];
  articleTypes?: string[];
  statuses?: string[];
  allotters?: string[];
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
  /** Mean turnaround. Diverges from the median when a few pieces run long. */
  avgTatHours: number;
  p90TatHours: number;
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
  medianTatHours: number;
  avgTatHours: number;
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
  medianTatHours: number;
  avgTatHours: number;
  /** Null where allotment carries no clock time, making the leg unmeasurable. */
  medianWriteHours: number | null;
  submissionRate: number;
  pending: number;
  /** Distinct days in the period on which they submitted anything. */
  activeDays: number;
  /**
   * Submissions per active day. Days off and leave are excluded rather than
   * averaged in, so this reads as "what they do on a working day" instead of
   * penalising anyone who was away.
   */
  perActiveDay: number;
}

export interface EditorStats {
  editor: string;
  division: string;
  handled: number;
  verified: number;
  sentBack: number;
  sendBackRate: number;
  secondPass: number;
  medianReviewHours: number | null;
  avgReviewHours: number | null;
  /** Distinct days in the period on which they handled anything. */
  activeDays: number;
  /** Pieces handled per active day — see WriterStats.perActiveDay. */
  perActiveDay: number;
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
  avg: number;
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
  /** Median and mean hours in each leg; null where the source lacks the timestamps. */
  stages: {
    stage: string;
    median: number | null;
    avg: number | null;
    p90: number | null;
    count: number;
  }[];
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
  publishRate: number;
  medianTatHours: number;
  avgTatHours: number;
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
  avgTatHours: number;
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
  weekdayRhythm: {
    weekday: string;
    allotted: number;
    submitted: number;
    published: number;
    medianTatHours: number;
    avgTatHours: number;
  }[];
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
