// ── Parsed row types (used by sync service → entity mapping) ──

export interface ParsedSourceRow {
  rowId: string;
  date: string | null;
  brand: string;
  contentType: string;
  feed: string;
  writer: string;
  editor: string;
  status: string;
  numberOfSlides: number | null;
  publishTimestamp: Date | null;
  title: string;
  rawHash: string;
}

export interface ParsedAllotmentRow {
  allottedBy: string;
  date: string | null;
  brand: string;
  feed: string;
  writer: string;
  contentType: string;
  status: string;
  slides: number | null;
  title: string;
  rawHash: string;
}

// ── Query/filter types ──

export interface MsnFilterParams {
  startDate?: string;
  endDate?: string;
  brands?: string[];
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

export interface LeakageResult {
  publishedWithoutAllotment: {
    title: string;
    date: string;
    writer: string;
    feed: string;
  }[];
  allottedWithoutPublish: {
    title: string;
    date: string;
    writer: string;
    feed: string;
  }[];
  publishedWithoutAllotmentCount: number;
  allottedWithoutPublishCount: number;
}

export interface FilterOptions {
  brands: string[];
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
  sourceRowCount: number;
  allotmentRowCount: number;
  syncing: boolean;
  error: string | null;
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
