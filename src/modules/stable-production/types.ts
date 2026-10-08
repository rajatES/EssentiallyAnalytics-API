// Stable Production result shapes. Mirrored by the UI at
// src/features/stable-production/types.ts — keep the two in step.

export interface StableFilterParams {
  events?: string[];
  sports?: string[];
  writers?: string[];
  editors?: string[];
  stableTypes?: string[];
  stages?: string[];
  kinds?: string[];
}

export interface ParsedSpPiece {
  id: string;
  event: string;
  eventOrder: number;
  sport: string;
  sheetRow: number;
  player: string;
  stableType: string;
  pieceKind: string;
  title: string;
  hasHeadline: boolean;
  writer: string;
  editor: string;
  editingStatus: string;
  stage: string;
  writtenStatus: string;
  researchDoc: string;
  submissionDoc: string;
  stagingLink: string;
  publishedUrl: string;
  scheduleNote: string;
  editorComments: string;
  rawHash: string;
}

export interface ParsedSpRosterPerson {
  id: string;
  name: string;
  position: string;
  roleGroup: string;
  dailyTarget: number | null;
  bandwidthNote: string;
  timings: string;
  shift: string;
  weekoff: string;
  sortOrder: number;
  rawHash: string;
}

export interface StableSyncStatus {
  lastSyncTime: string | null;
  rowCount: number;
  eventCount: number;
  rosterCount: number;
  syncing: boolean;
  error: string | null;
  /** Tabs read this sync that did not match the event template. */
  skippedTabs: string[];
}

export interface StableEventOption {
  event: string;
  sport: string;
  order: number;
  pieces: number;
  open: number;
}

export interface StableFilterOptions {
  events: StableEventOption[];
  sports: string[];
  writers: string[];
  editors: string[];
  stableTypes: string[];
  stages: string[];
  kinds: string[];
}

export interface StageCount {
  stage: string;
  count: number;
}

/** Counts every surface shares, so tables and tiles cannot disagree. */
export interface StageTotals {
  allotted: number;
  submitted: number;
  verified: number;
  published: number;
  sentBack: number;
  onHold: number;
  trashed: number;
  awaitingSubmission: number;
  awaitingEditorial: number;
  inEditorial: number;
  /** Verified but not yet scheduled or live. */
  verifiedUnpublished: number;
  /** Still needs someone to act. */
  open: number;
  /** Verified or published, out of everything not trashed. */
  completionRate: number;
}

export interface StableOverview extends StageTotals {
  events: number;
  writers: number;
  editors: number;
  newCount: number;
  updateCount: number;
  stages: StageCount[];
}

export interface NamedCount {
  name: string;
  count: number;
}

export interface StableEventStats extends StageTotals {
  event: string;
  sport: string;
  order: number;
  newCount: number;
  updateCount: number;
  writers: NamedCount[];
  editors: NamedCount[];
  stableTypes: NamedCount[];
}

export interface StableWriterStats extends StageTotals {
  writer: string;
  onRoster: boolean;
  dailyTarget: number | null;
  shift: string;
  events: NamedCount[];
}

export interface StableEditorStats {
  editor: string;
  onRoster: boolean;
  handled: number;
  verified: number;
  published: number;
  sentBack: number;
  inEditorial: number;
  onHold: number;
  trashed: number;
  events: NamedCount[];
}

export interface StableTypeStats {
  stableType: string;
  count: number;
  verified: number;
  published: number;
  open: number;
}

export interface StableTypeMatrix {
  types: string[];
  rows: {
    event: string;
    sport: string;
    order: number;
    total: number;
    cells: Record<string, number>;
  }[];
  totals: StableTypeStats[];
}

export interface StableQueueItem {
  id: string;
  event: string;
  sport: string;
  sheetRow: number;
  player: string;
  title: string;
  stableType: string;
  pieceKind: string;
  writer: string;
  editor: string;
  stage: string;
  editingStatus: string;
  stagingLink: string;
  researchDoc: string;
  editorComments: string;
}

export interface StableQueue {
  stages: StageCount[];
  items: StableQueueItem[];
  total: number;
}

export interface StableRosterEntry {
  name: string;
  position: string;
  roleGroup: string;
  dailyTarget: number | null;
  bandwidthNote: string;
  timings: string;
  shift: string;
  weekoff: string;
  offToday: boolean;
  open: number;
  total: number;
}

export interface StableQualityIssue {
  issue: string;
  count: number;
  detail: string;
}

export interface StableQuality {
  issues: StableQualityIssue[];
  /** Raw spellings folded into one person, so the merges can be checked. */
  nameMerges: {
    name: string;
    spellings: { spelling: string; pieces: number }[];
  }[];
  /** Writers or editors doing the work who are not on the Daily Schedule. */
  unrostered: { name: string; role: string; pieces: number }[];
  /**
   * The same player and stable type allotted twice in one event, or written as
   * New more than once across events.
   */
  duplicates: {
    player: string;
    stableType: string;
    count: number;
    /** True when the repeat is inside a single event. */
    sameEvent: boolean;
    events: string[];
    writers: string[];
  }[];
}
