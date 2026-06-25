// ── Parsed row type (sync service → entity mapping) ──

export interface ParsedPiece {
  id: string;
  uniquePieceId: string;
  category: string;
  feed: string;
  writer: string;
  editor: string;
  allottedBy: string;
  contentType: string;
  publishingStatus: string;
  editorialStatus: string;
  slides: number | null;
  allottedAt: Date | null;
  pickedAt: Date | null;
  submittedAt: Date | null;
  verifyStart: Date | null;
  verifyEnd: Date | null;
  publishedAt: Date | null;
  date: string | null;
  title: string;
  pickedBy: string;
  primarySource: string;
  sourcesUsed: string;
  stagingLink: string;
  featuredImage: string;
  feedback: string;
  comments: string;
  rawHash: string;
}

export interface ParsedRosterPerson {
  id: string;
  division: string;
  feed: string;
  name: string;
  role: string;
  weekoff: string;
  rawHash: string;
}

export interface ParsedModerationRow {
  id: string;
  checkedAt: Date | null;
  title: string;
  titleNorm: string;
  checkedBy: string;
  feed: string;
  category: string;
  riskRating: number | null;
  overallResult: boolean;
  reason: string;
  tbScore: string;
  legalScore: string;
  feedScore: string;
  subjectiveScore: string;
  rawHash: string;
}

// ── Query/filter types ──

export interface MsnFilterParams {
  startDate?: string;
  endDate?: string;
  categories?: string[];
  feeds?: string[];
  writers?: string[];
  editors?: string[];
  contentTypes?: string[];
  statuses?: string[];
  allotters?: string[];
}

export interface KpiOverview {
  totalProduced: number;
  totalAllotted: number;
  published: number;
  scheduled: number;
  publishRate: number;
  avgLeadTimeHours: number;
  piecesPerWriterPerDay: number;
  dropOffRate: number;
  deltas: {
    totalProduced: number;
    totalAllotted: number;
    published: number;
    scheduled: number;
    publishRate: number;
    avgLeadTimeHours: number;
    piecesPerWriterPerDay: number;
    dropOffRate: number;
  };
}

export interface TimeseriesBucket {
  date: string;
  article: number;
  slideshow: number;
  ssAutomation: number;
  allotted: number;
  published: number;
}

export interface FunnelStage {
  stage: string;
  count: number;
  percentage: number;
  dropOff: number;
}

export interface StatusMixEntry {
  status: string;
  count: number;
  percentage: number;
}

export interface FeedStats {
  feed: string;
  allotted: number;
  produced: number;
  published: number;
  publishRate: number;
  avgLeadTimeHours: number;
  articles: number;
  slideshows: number;
  ssAutomation: number;
}

export interface WriterStats {
  writer: string;
  allotted: number;
  submitted: number;
  published: number;
  publishRate: number;
  sentBackRate: number;
  avgLeadTimeHours: number;
  articles: number;
  slideshows: number;
  total: number;
}

export interface EditorStats {
  editor: string;
  articlesEdited: number;
  avgTurnaroundHours: number;
  sentBackRate: number;
  contentTypes: string[];
}

export interface AllotterStats {
  allottedBy: string;
  volume: number;
  publishedRate: number;
  avgLeadTimeHours: number;
  topFeed: string;
  topWriter: string;
}

export interface ContentMixEntry {
  period: string;
  article: number;
  slideshow: number;
  ssAutomation: number;
  articlePct: number;
  slideshowPct: number;
  ssAutomationPct: number;
}

export interface HeatmapCell {
  row: string;
  col: string;
  value: number;
}

// ── Pipeline drop-off (replaces cross-sheet leakage) ──

export interface LeakageItem {
  title: string;
  date: string;
  writer: string;
  feed: string;
  allottedBy: string;
}

export interface LeakageResult {
  allottedNotSubmitted: LeakageItem[];
  submittedNotPublished: LeakageItem[];
  allottedNotSubmittedCount: number;
  submittedNotPublishedCount: number;
}

// ── Stage durations (new lifecycle analytics) ──

export interface StageDurationStat {
  stage: string;
  medianHours: number;
  avgHours: number;
  p90Hours: number;
  sampleSize: number;
}

export interface StageDurationByEntity {
  name: string;
  pickLatencyHours: number;
  writingHours: number;
  editingHours: number;
  publishHours: number;
  totalHours: number;
  count: number;
}

export interface StageDurationResult {
  stages: StageDurationStat[];
  byFeed: StageDurationByEntity[];
  byWriter: StageDurationByEntity[];
}

export interface FilterOptions {
  categories: string[];
  feeds: string[];
  writers: string[];
  editors: string[];
  contentTypes: string[];
  statuses: string[];
  allotters: string[];
  dateRange: { min: string; max: string };
}

export interface DailyBreakdownEntry {
  name: string;
  date: string;
  slides: number;
  slideshows: number;
  articles: number;
  total: number;
}

export interface PersonAverage {
  name: string;
  avgSlides: number;
  avgSlideshows: number;
  avgArticles: number;
  avgTotal: number;
  activeDays: number;
  totalSlides: number;
  totalSlideshows: number;
  totalArticles: number;
}

export interface DailyBreakdownResult {
  daily: DailyBreakdownEntry[];
  personalAverages: PersonAverage[];
  teamAverage: {
    avgSlides: number;
    avgSlideshows: number;
    avgArticles: number;
    avgTotal: number;
  };
}

export interface SyncStatus {
  lastSyncTime: string | null;
  rowCount: number;
  rosterCount: number;
  moderationCount: number;
  syncing: boolean;
  error: string | null;
}

// ── Live stage board (work-in-progress right now) ──

export interface StageBoardPiece {
  id: string;
  title: string;
  writer: string;
  editor: string;
  feed: string;
  category: string;
  contentType: string;
  ageHours: number;
  enteredAt: string | null;
}

export interface StageBoardStage {
  key: string;
  label: string;
  count: number;
  medianAgeHours: number;
  oldestAgeHours: number;
  pieces: StageBoardPiece[];
}

export interface StuckPiece extends StageBoardPiece {
  stage: string;
  stageKey: string;
}

export interface StageBoardResult {
  asOf: string;
  totalWip: number;
  doneLast24h: number;
  stages: StageBoardStage[];
  stuck: StuckPiece[];
}

// ── People availability (roster × active assignments) ──

export interface PersonAvailability {
  name: string;
  divisions: string[];
  feeds: string[];
  roles: string[];
  weekoff: string;
  isWeekoffToday: boolean;
  activeWriting: number;
  activeEditing: number;
  activePieces: number;
  publishedLast7Days: number;
  status: 'weekoff' | 'busy' | 'free';
  inRoster: boolean;
}

export interface DivisionBandwidth {
  division: string;
  total: number;
  busy: number;
  free: number;
  weekoffToday: number;
  utilization: number;
}

export interface AvailabilityResult {
  asOf: string;
  weekdayToday: string;
  people: PersonAvailability[];
  divisions: DivisionBandwidth[];
  unmatchedActive: PersonAvailability[];
}

// ── Category (division) split ──

export interface CategorySplitEntry {
  category: string;
  total: number;
  published: number;
  scheduled: number;
  wip: number;
  dropped: number;
}

export interface RepeatingTitleEntry {
  title: string;
  count: number;
  assignments: {
    writer: string;
    date: string;
    feed: string;
    allottedBy: string;
    status: string;
  }[];
}

export interface RepeatingTitlesResult {
  titles: RepeatingTitleEntry[];
  totalCount: number;
}

// ── Insights (content + personnel decision support) ──

export interface ContentTypeInsight {
  contentType: string;
  total: number;
  published: number;
  dropped: number;
  publishRate: number;
  dropRate: number;
  medianCycleHours: number;
  medianWriteHours: number;
  avgSlides: number | null;
}

export interface WeekdayPatternEntry {
  weekday: string; // Mon..Sun
  allotted: number;
  published: number;
  medianCycleHours: number;
}

export interface PublishHeatCell {
  weekday: string; // Mon..Sun
  hour: number; // 0-23, IST
  count: number;
}

export interface DropStageEntry {
  stage: string;
  count: number;
}

export interface DropByGroup {
  name: string;
  dropped: number;
  total: number;
  dropRate: number;
}

export interface DropAnalysis {
  totalDropped: number;
  dropRate: number;
  byStage: DropStageEntry[];
  byCategory: DropByGroup[];
  byFeed: DropByGroup[];
}

export interface WriterQuadrantEntry {
  writer: string;
  pieces: number;
  medianWriteHours: number;
  publishRate: number;
  sentBackRate: number;
}

export interface PairMatrixEntry {
  writer: string;
  editor: string;
  pieces: number;
  medianReviewHours: number;
  sentBacks: number;
}

export interface MomentumEntry {
  name: string;
  weekly: number[]; // 6 rolling 7-day windows, oldest → newest
  total: number;
  trendPct: number; // latest window vs avg of prior windows
  direction: 'up' | 'down' | 'flat';
}

export interface DivisionLoadEntry {
  division: string;
  published: number;
  activeWriters: number;
  perWriter: number;
  freePeople: number;
  weekoffToday: number;
}

export interface InsightsResult {
  asOf: string;
  contentTypes: ContentTypeInsight[];
  weekdayPattern: WeekdayPatternEntry[];
  publishHeatmap: PublishHeatCell[];
  dropAnalysis: DropAnalysis;
  writerQuadrant: WriterQuadrantEntry[];
  pairMatrix: PairMatrixEntry[];
  momentum: MomentumEntry[];
  divisionLoad: DivisionLoadEntry[];
}

// ── Production scoreboard (allotted vs drafted vs edited, per person) ──

export interface ProductionCounts {
  pieces: number;
  articles: number;
  slideshows: number;
  slides: number;
}

export interface AllotterProductionRow extends ProductionCounts {
  name: string;
  perDay: number;
}

export interface WriterProductionRow {
  writer: string;
  allotted: ProductionCounts;
  picked: ProductionCounts;
  drafted: ProductionCounts;
  /** Allotted but not yet picked up (allotted − picked). */
  notPickedPieces: number;
  /** Picked but not yet submitted (picked − drafted). */
  pickedNotDraftedPieces: number;
  /** Total shortfall (allotted − drafted) = notPicked + pickedNotDrafted. */
  deltaPieces: number;
  deltaSlides: number;
  draftRate: number;
  pickRate: number;
  medianWriteHours: number;
  perDay: number;
}

export interface EditorProductionRow extends ProductionCounts {
  editor: string;
  pending: number;
  medianEditHours: number;
  perDay: number;
}

export interface ProductionSummary {
  allotted: ProductionCounts;
  picked: ProductionCounts;
  drafted: ProductionCounts;
  edited: ProductionCounts;
  /** Published/scheduled without review (PR) — excluded from edit rate & averages. */
  prPublished: ProductionCounts;
  pickRate: number;
  draftRate: number;
  editRate: number;
  medianWriteHours: number;
  medianEditHours: number;
}

export interface ProductionResult {
  summary: ProductionSummary;
  allotters: AllotterProductionRow[];
  writers: WriterProductionRow[];
  editors: EditorProductionRow[];
}

// ── Moderation coverage (production sheet × moderation tool log) ──

export type ModerationBucket = 'never' | 'over-month' | 'over-2w';

export interface UnmoderatedPiece {
  id: string;
  title: string;
  writer: string;
  allottedBy: string;
  feed: string;
  category: string;
  contentType: string;
  publishingStatus: string;
  date: string | null;
  lastCheckedAt: string | null;
  daysSinceCheck: number | null;
  checkCount: number;
  bucket: ModerationBucket;
  isPublished: boolean;
}

export interface ModerationGroupCount {
  name: string;
  never: number;
  stale: number; // over-2w + over-month combined
  total: number;
}

export interface ModeratorStat {
  user: string;
  checks: number;
  distinctTitles: number;
  passRate: number;
  avgRisk: number | null;
  lastCheckAt: string | null;
  checksLast7d: number;
}

export interface RecheckEntry {
  title: string;
  count: number;
  users: string[];
  lastCheckedAt: string | null;
  lastResult: boolean;
  riskRating: number | null;
}

export interface ModerationTimelinePoint {
  date: string;
  checks: number;
  passed: number;
  failed: number;
}

export interface FailDimensionEntry {
  dimension: string;
  fails: number;
  evaluated: number;
  failRate: number;
}

export interface ModerationSummaryStats {
  totalPieces: number;
  moderatedRecent: number;
  over2w: number;
  overMonth: number;
  never: number;
  unmoderatedTotal: number;
  coverageRate: number;
  publishedUnmoderated: number;
  totalChecks: number;
  distinctTitlesChecked: number;
  passRate: number;
  avgRisk: number | null;
}

export interface ModerationResult {
  asOf: string;
  summary: ModerationSummaryStats;
  unmoderated: UnmoderatedPiece[];
  byFeed: ModerationGroupCount[];
  byCategory: ModerationGroupCount[];
  moderators: ModeratorStat[];
  rechecks: RecheckEntry[];
  timeline: ModerationTimelinePoint[];
  failDimensions: FailDimensionEntry[];
}

// ── Duplicate allotments (same title allotted more than once) ──

export interface DuplicateAllotment {
  date: string | null;
  allottedAt: string | null;
  writer: string;
  allottedBy: string;
  feed: string;
  status: string;
}

export interface DuplicateTitleEntry {
  title: string;
  category: string;
  count: number;
  crossFeed: boolean;
  distinctWriters: number;
  first: DuplicateAllotment;
  repeats: DuplicateAllotment[];
}

export interface DuplicateGroupAgg {
  name: string;
  groups: number;
  extras: number;
}

export interface DuplicatesResult {
  asOf: string;
  duplicateTitles: number;
  extraAllotments: number;
  affectedPieces: number;
  crossFeedGroups: number;
  byCategory: DuplicateGroupAgg[];
  byFeed: DuplicateGroupAgg[];
  topAllotters: DuplicateGroupAgg[];
  titles: DuplicateTitleEntry[];
}
