import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Repository,
  Between,
  In,
  LessThanOrEqual,
  MoreThanOrEqual,
} from 'typeorm';
import { SheetsSyncService } from './sheets-sync.service';
import { MsnPiece } from './entities/msn-piece.entity';
import { MsnRosterPerson } from './entities/msn-roster-person.entity';
import { MsnModerationRow } from './entities/msn-moderation-row.entity';
import { normalizeTitleKey, toDateOnly } from './normalization';
import {
  MsnFilterParams,
  KpiOverview,
  TimeseriesBucket,
  FunnelStage,
  StatusMixEntry,
  FeedStats,
  WriterStats,
  EditorStats,
  AllotterStats,
  ProductionResult,
  ProductionCounts,
  ProductionSummary,
  ContentMixEntry,
  HeatmapCell,
  LeakageResult,
  LeakageItem,
  FilterOptions,
  SyncStatus,
  DailyBreakdownEntry,
  PersonAverage,
  DailyBreakdownResult,
  RepeatingTitleEntry,
  RepeatingTitlesResult,
  StageDurationResult,
  StageDurationStat,
  StageDurationByEntity,
  StageBoardResult,
  StageBoardStage,
  StageBoardPiece,
  StuckPiece,
  AvailabilityResult,
  PersonAvailability,
  DivisionBandwidth,
  CategorySplitEntry,
  InsightsResult,
  ContentTypeInsight,
  WeekdayPatternEntry,
  PublishHeatCell,
  DropAnalysis,
  DropStageEntry,
  DropByGroup,
  WriterQuadrantEntry,
  PairMatrixEntry,
  MomentumEntry,
  DivisionLoadEntry,
  ModerationResult,
  DuplicatesResult,
  DuplicateTitleEntry,
  DuplicateAllotment,
  DuplicateGroupAgg,
  ModerationBucket,
  UnmoderatedPiece,
  ModerationGroupCount,
  ModeratorStat,
  RecheckEntry,
  ModerationTimelinePoint,
  FailDimensionEntry,
} from './types';

const PUBLISHED_STATUSES = ['Published', 'Published (PR)'];
const SCHEDULED_STATUSES = ['Scheduled', 'Scheduled (PR)'];
const DROPPED_STATUSES = ['Sent Back', 'Trashed', 'Scrapped'];

/** Hours between two timestamps, or null if out of a sane [0, capHours] range. */
function hoursBetween(
  from: Date | null,
  to: Date | null,
  capHours = 720,
): number | null {
  if (!from || !to) return null;
  const diff = (new Date(to).getTime() - new Date(from).getTime()) / 3600000;
  if (diff < 0 || diff > capHours) return null;
  return diff;
}

function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  const val =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return Math.round(val * 10) / 10;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx] * 10) / 10;
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

@Injectable()
export class MsnProductionService {
  private readonly logger = new Logger(MsnProductionService.name);

  private lastSyncTime: Date | null = null;
  private syncing = false;
  private lastError: string | null = null;

  constructor(
    private readonly sheetsSyncService: SheetsSyncService,
    @InjectRepository(MsnPiece)
    private readonly pieceRepo: Repository<MsnPiece>,
    @InjectRepository(MsnRosterPerson)
    private readonly rosterRepo: Repository<MsnRosterPerson>,
    @InjectRepository(MsnModerationRow)
    private readonly moderationRepo: Repository<MsnModerationRow>,
  ) {}

  async onModuleInit() {
    this.syncData().catch((e) =>
      this.logger.error(`Initial sync failed: ${e.message}`),
    );
  }

  @Cron('*/15 * * * *')
  async handleCronSync() {
    await this.syncData();
  }

  async syncData(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.lastError = null;
    try {
      const pieces = await this.sheetsSyncService.fetchPieces();

      if (pieces.length > 0) {
        const existing = await this.pieceRepo.find({
          select: ['id', 'rawHash'],
        });
        const existingHashes = new Map<string, string>();
        for (const row of existing) existingHashes.set(row.id, row.rawHash);

        // Keyed by id (last-wins): the integrated sheet can hold two rows that
        // hash to the same piece id (identical category/feed/title/allot time),
        // and a single upsert batch must not target the same id twice — Postgres
        // rejects with "ON CONFLICT DO UPDATE cannot affect row a second time".
        const toUpsert = new Map<string, MsnPiece>();
        const incomingIds = new Set<string>();

        for (const p of pieces) {
          incomingIds.add(p.id);
          if (existingHashes.get(p.id) === p.rawHash) continue;

          const entity = new MsnPiece();
          Object.assign(entity, p);
          toUpsert.set(p.id, entity);
        }

        if (toUpsert.size > 0) {
          const rows = [...toUpsert.values()];
          for (let i = 0; i < rows.length; i += 500) {
            await this.pieceRepo.upsert(rows.slice(i, i + 500), ['id']);
          }
          this.logger.log(`Pieces: upserted ${rows.length} changed rows`);
        }

        const staleIds = [...existingHashes.keys()].filter(
          (id) => !incomingIds.has(id),
        );
        if (staleIds.length > 0) {
          for (let i = 0; i < staleIds.length; i += 500) {
            await this.pieceRepo.delete(staleIds.slice(i, i + 500));
          }
          this.logger.log(`Pieces: removed ${staleIds.length} stale rows`);
        }
      }

      // Roster tab — same hash-diff upsert pattern. A failed/empty fetch
      // leaves the existing roster untouched rather than wiping it.
      const roster = await this.sheetsSyncService.fetchRoster();
      if (roster.length > 0) {
        const existing = await this.rosterRepo.find({
          select: ['id', 'rawHash'],
        });
        const existingHashes = new Map<string, string>();
        for (const row of existing) existingHashes.set(row.id, row.rawHash);

        // Keyed by id (last-wins) so duplicate roster ids never land in the
        // same upsert batch (see pieces block above).
        const toUpsert = new Map<string, MsnRosterPerson>();
        const incomingIds = new Set<string>();
        for (const r of roster) {
          incomingIds.add(r.id);
          if (existingHashes.get(r.id) === r.rawHash) continue;
          const entity = new MsnRosterPerson();
          Object.assign(entity, r);
          toUpsert.set(r.id, entity);
        }
        if (toUpsert.size > 0) {
          const rows = [...toUpsert.values()];
          for (let i = 0; i < rows.length; i += 500) {
            await this.rosterRepo.upsert(rows.slice(i, i + 500), ['id']);
          }
          this.logger.log(`Roster: upserted ${rows.length} changed rows`);
        }
        const staleIds = [...existingHashes.keys()].filter(
          (id) => !incomingIds.has(id),
        );
        if (staleIds.length > 0) {
          await this.rosterRepo.delete(staleIds);
          this.logger.log(`Roster: removed ${staleIds.length} stale rows`);
        }
      }

      // Moderation log — hash-diff upsert; a failed/empty fetch leaves the
      // existing rows untouched.
      const moderation = await this.sheetsSyncService.fetchModeration();
      if (moderation.length > 0) {
        const existing = await this.moderationRepo.find({
          select: ['id', 'rawHash'],
        });
        const existingHashes = new Map<string, string>();
        for (const row of existing) existingHashes.set(row.id, row.rawHash);

        const toUpsert: MsnModerationRow[] = [];
        const incomingIds = new Set<string>();
        for (const m of moderation) {
          incomingIds.add(m.id);
          if (existingHashes.get(m.id) === m.rawHash) continue;
          const entity = new MsnModerationRow();
          Object.assign(entity, m);
          toUpsert.push(entity);
        }
        if (toUpsert.length > 0) {
          for (let i = 0; i < toUpsert.length; i += 500) {
            await this.moderationRepo.upsert(toUpsert.slice(i, i + 500), ['id']);
          }
          this.logger.log(`Moderation: upserted ${toUpsert.length} changed rows`);
        }
        const staleIds = [...existingHashes.keys()].filter(
          (id) => !incomingIds.has(id),
        );
        if (staleIds.length > 0) {
          for (let i = 0; i < staleIds.length; i += 500) {
            await this.moderationRepo.delete(staleIds.slice(i, i + 500));
          }
          this.logger.log(`Moderation: removed ${staleIds.length} stale rows`);
        }
      }

      const count = await this.pieceRepo.count();
      const rosterCount = await this.rosterRepo.count();
      const moderationCount = await this.moderationRepo.count();
      this.lastSyncTime = new Date();
      this.logger.log(
        `Sync complete: ${count} pieces, ${rosterCount} roster rows, ${moderationCount} moderation rows in DB`,
      );
    } catch (e: any) {
      this.lastError = e.message;
      this.logger.error(`Sync failed: ${e.message}`);
    } finally {
      this.syncing = false;
    }
  }

  async getSyncStatus(): Promise<SyncStatus> {
    const rowCount = await this.pieceRepo.count();
    const rosterCount = await this.rosterRepo.count();
    const moderationCount = await this.moderationRepo.count();
    return {
      lastSyncTime: this.lastSyncTime?.toISOString() ?? null,
      rowCount,
      rosterCount,
      moderationCount,
      syncing: this.syncing,
      error: this.lastError,
    };
  }

  // ── Filtering helpers ──

  private buildWhere(params: MsnFilterParams, includeDate = true): any {
    const where: any = {};
    if (includeDate) {
      if (params.startDate && params.endDate) {
        where.date = Between(params.startDate, params.endDate);
      } else if (params.startDate) {
        where.date = MoreThanOrEqual(params.startDate);
      } else if (params.endDate) {
        where.date = LessThanOrEqual(params.endDate);
      }
    }
    if (params.categories?.length) where.category = In(params.categories);
    if (params.feeds?.length) where.feed = In(params.feeds);
    if (params.writers?.length) where.writer = In(params.writers);
    if (params.editors?.length) where.editor = In(params.editors);
    if (params.contentTypes?.length)
      where.contentType = In(params.contentTypes);
    if (params.statuses?.length) where.publishingStatus = In(params.statuses);
    if (params.allotters?.length) where.allottedBy = In(params.allotters);
    return where;
  }

  /** Raw fetch — every matching row, including duplicate re-allotments. */
  private async filterRaw(params: MsnFilterParams): Promise<MsnPiece[]> {
    return this.pieceRepo.find({ where: this.buildWhere(params) });
  }

  /**
   * Deduped fetch — the default for every metric. A piece allotted more than
   * once shares a uniquePieceId across rows; we keep one representative per
   * uniquePieceId so each real piece is counted exactly once. The raw rows
   * stay available via filterRaw() for the duplicates view.
   */
  private async filter(params: MsnFilterParams): Promise<MsnPiece[]> {
    return this.dedupePieces(await this.filterRaw(params));
  }

  /**
   * Deduped fetch where the date range is applied against a chosen lifecycle
   * anchor (picked / verify) instead of the allotment-anchored `date` column.
   * Used for writer- and editor-centric views so a piece counts on the day the
   * person actually worked it, not the day it was handed out. Non-date filters
   * (category/feed/…) still apply in SQL; the date window is matched in JS.
   */
  private async filterByAnchor(
    params: MsnFilterParams,
    anchor: 'allotment' | 'picked' | 'verify',
  ): Promise<MsnPiece[]> {
    const rows = this.dedupePieces(
      await this.pieceRepo.find({ where: this.buildWhere(params, false) }),
    );
    return rows.filter((r) => this.inRange(this.anchorDay(r, anchor), params));
  }

  /** Lifecycle stage a piece has reached — used to pick the truest dup row. */
  private progressRank(p: MsnPiece): number {
    if (this.isPublished(p) || this.isScheduled(p) || p.publishedAt) return 5;
    if (p.verifyEnd || p.editorialStatus === 'Verified') return 4;
    if (p.verifyStart) return 3;
    if (p.submittedAt || p.publishingStatus === 'Submitted') return 2;
    if (p.pickedAt) return 1;
    return 0;
  }

  /**
   * Collapse re-allotments to one row per uniquePieceId. The representative is
   * the furthest-progressed row (so a piece completed via a later allotment is
   * never under-counted), tie-broken by earliest allotment (the original).
   * Rows with a blank uniquePieceId have no canonical identity and pass through
   * untouched.
   */
  private dedupePieces(rows: MsnPiece[]): MsnPiece[] {
    const allotTime = (p: MsnPiece) =>
      p.allottedAt ? new Date(p.allottedAt).getTime() : Number.MAX_SAFE_INTEGER;
    const best = new Map<string, MsnPiece>();
    const passthrough: MsnPiece[] = [];
    for (const r of rows) {
      const upid = r.uniquePieceId?.trim();
      if (!upid) {
        passthrough.push(r);
        continue;
      }
      const cur = best.get(upid);
      if (!cur) {
        best.set(upid, r);
        continue;
      }
      const rRank = this.progressRank(r);
      const cRank = this.progressRank(cur);
      if (rRank > cRank || (rRank === cRank && allotTime(r) < allotTime(cur))) {
        best.set(upid, r);
      }
    }
    return [...best.values(), ...passthrough];
  }

  private getPreviousPeriodParams(params: MsnFilterParams): MsnFilterParams {
    if (!params.startDate || !params.endDate) return params;
    const start = new Date(params.startDate);
    const end = new Date(params.endDate);
    const diff = end.getTime() - start.getTime();
    const prevEnd = new Date(start.getTime() - 86400000);
    const prevStart = new Date(prevEnd.getTime() - diff);
    return {
      ...params,
      startDate: prevStart.toISOString().split('T')[0],
      endDate: prevEnd.toISOString().split('T')[0],
    };
  }

  private calcDelta(current: number, previous: number): number {
    if (previous === 0) return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 1000) / 10;
  }

  private isPublished(p: MsnPiece): boolean {
    return PUBLISHED_STATUSES.includes(p.publishingStatus);
  }

  private isScheduled(p: MsnPiece): boolean {
    return SCHEDULED_STATUSES.includes(p.publishingStatus);
  }

  /**
   * A piece counts as "published" for output metrics once it is live or locked
   * in to go live: Published / Published (PR) / Scheduled / Scheduled (PR). The
   * team treats scheduled work as done, so every published count and publish
   * rate includes it (only the actual publish-timestamp analytics — heatmap,
   * weekday rhythm, momentum — stay on real publish events).
   */
  private countsAsPublished(p: MsnPiece): boolean {
    return this.isPublished(p) || this.isScheduled(p);
  }

  /** Day-string (YYYY-MM-DD) for a timestamp, matching how `date` is derived at sync. */
  private dayOf(ts: Date | null): string | null {
    return ts ? toDateOnly(new Date(ts)) : null;
  }

  /**
   * The calendar day a piece is attributed to under a given lens:
   *  - allotment: when it was handed out (the stored `date`)
   *  - picked: when the writer started it (the writer's work day)
   *  - verify: when the editor began review (the editor's work day)
   * A piece allotted one day but picked the next belongs to the writer on the
   * pick day — counting it on the allotment day understates that day's output.
   * Falls back to the allotment day when the work timestamp is missing, so a
   * piece is never dropped from a dated view (the change is strictly: use the
   * real work day when known, otherwise behave as before).
   */
  private anchorDay(
    p: MsnPiece,
    anchor: 'allotment' | 'picked' | 'verify',
  ): string | null {
    if (anchor === 'picked') return this.dayOf(p.pickedAt) ?? p.date;
    if (anchor === 'verify') return this.dayOf(p.verifyStart) ?? p.date;
    return p.date;
  }

  /** True when `day` falls inside the (optional) requested range. Null day = out. */
  private inRange(day: string | null, params: MsnFilterParams): boolean {
    if (!day) return false;
    if (params.startDate && day < params.startDate) return false;
    if (params.endDate && day > params.endDate) return false;
    return true;
  }

  /**
   * PR-published pieces ("Published (PR)" / "Scheduled (PR)") go live without
   * passing through review/verification. They have no editor or verify step by
   * design, so they're excluded from review/edit averages and rates (but kept
   * in volume, writing, lead-time and publish counts).
   */
  private isPrPublished(p: MsnPiece): boolean {
    return /\(\s*pr\s*\)/i.test(p.publishingStatus);
  }

  private isSubmitted(p: MsnPiece): boolean {
    return (
      !!p.submittedAt ||
      this.isPublished(p) ||
      this.isScheduled(p) ||
      p.publishingStatus === 'Submitted' ||
      p.editorialStatus === 'Verified'
    );
  }

  // ── Public query methods ──

  async getFilterOptions(): Promise<FilterOptions> {
    const rows = await this.pieceRepo.find();

    const categories = new Set<string>();
    const feeds = new Set<string>();
    const writers = new Set<string>();
    const editors = new Set<string>();
    const contentTypes = new Set<string>();
    const statuses = new Set<string>();
    const allotters = new Set<string>();
    let minDate = '';
    let maxDate = '';

    for (const r of rows) {
      if (r.category && r.category !== 'Unknown') categories.add(r.category);
      if (r.feed && r.feed !== 'Unknown') feeds.add(r.feed);
      if (r.writer && r.writer !== 'Unknown') writers.add(r.writer);
      if (r.editor && r.editor !== 'Unknown') editors.add(r.editor);
      if (r.contentType && r.contentType !== 'Unknown')
        contentTypes.add(r.contentType);
      if (r.publishingStatus && r.publishingStatus !== 'Unknown')
        statuses.add(r.publishingStatus);
      if (r.allottedBy && r.allottedBy !== 'Unknown')
        allotters.add(r.allottedBy);
      if (r.date) {
        if (!minDate || r.date < minDate) minDate = r.date;
        if (!maxDate || r.date > maxDate) maxDate = r.date;
      }
    }

    return {
      categories: [...categories].sort(),
      feeds: [...feeds].sort(),
      writers: [...writers].sort(),
      editors: [...editors].sort(),
      contentTypes: [...contentTypes].sort(),
      statuses: [...statuses].sort(),
      allotters: [...allotters].sort(),
      dateRange: { min: minDate, max: maxDate },
    };
  }

  async getOverview(params: MsnFilterParams): Promise<KpiOverview> {
    const rows = await this.filter(params);
    const prevRows = await this.filter(this.getPreviousPeriodParams(params));

    const cur = this.computeKpis(rows);
    const prev = this.computeKpis(prevRows);

    return {
      ...cur,
      deltas: {
        totalProduced: this.calcDelta(cur.totalProduced, prev.totalProduced),
        totalAllotted: this.calcDelta(cur.totalAllotted, prev.totalAllotted),
        published: this.calcDelta(cur.published, prev.published),
        scheduled: this.calcDelta(cur.scheduled, prev.scheduled),
        publishRate: this.calcDelta(cur.publishRate, prev.publishRate),
        avgLeadTimeHours: this.calcDelta(
          cur.avgLeadTimeHours,
          prev.avgLeadTimeHours,
        ),
        piecesPerWriterPerDay: this.calcDelta(
          cur.piecesPerWriterPerDay,
          prev.piecesPerWriterPerDay,
        ),
        dropOffRate: this.calcDelta(cur.dropOffRate, prev.dropOffRate),
      },
    };
  }

  private computeKpis(rows: MsnPiece[]): Omit<KpiOverview, 'deltas'> {
    const totalAllotted = rows.length;
    const totalProduced = rows.filter((r) => this.isSubmitted(r)).length;
    // "published" is the headline out-the-door count and includes scheduled
    // work (it's locked to go live); "scheduled" is surfaced as a breakdown.
    const published = rows.filter((r) => this.countsAsPublished(r)).length;
    const scheduled = rows.filter((r) => this.isScheduled(r)).length;
    const publishRate =
      totalAllotted > 0
        ? Math.round((published / totalAllotted) * 1000) / 10
        : 0;

    const leadTimes: number[] = [];
    for (const r of rows) {
      const lt = hoursBetween(r.allottedAt, r.publishedAt, 30 * 24);
      if (lt !== null) leadTimes.push(lt);
    }
    leadTimes.sort((a, b) => a - b);
    const avgLeadTimeHours = median(leadTimes);

    const writers = new Set(
      rows.map((r) => r.writer).filter((w) => w !== 'Unknown'),
    );
    const dates = new Set(rows.map((r) => r.date).filter(Boolean));
    const numDays = Math.max(dates.size, 1);
    const numWriters = Math.max(writers.size, 1);
    const piecesPerWriterPerDay =
      Math.round((totalProduced / numWriters / numDays) * 100) / 100;

    const dropOff = rows.filter(
      (r) =>
        DROPPED_STATUSES.includes(r.publishingStatus) ||
        DROPPED_STATUSES.includes(r.editorialStatus),
    ).length;
    const dropOffRate =
      totalAllotted > 0
        ? Math.round((dropOff / totalAllotted) * 1000) / 10
        : 0;

    return {
      totalProduced,
      totalAllotted,
      published,
      scheduled,
      publishRate,
      avgLeadTimeHours,
      piecesPerWriterPerDay,
      dropOffRate,
    };
  }

  async getTimeseries(
    params: MsnFilterParams,
    granularity: string = 'day',
  ): Promise<TimeseriesBucket[]> {
    const rows = await this.filter(params);

    const bucketKey = (dateStr: string | null): string => {
      if (!dateStr) return 'unknown';
      const d = new Date(dateStr);
      const dayStr = d.toISOString().split('T')[0];
      if (granularity === 'week') {
        const day = d.getUTCDay();
        const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
        const weekStart = new Date(
          Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff),
        );
        return weekStart.toISOString().split('T')[0];
      }
      if (granularity === 'month') return dayStr.substring(0, 7);
      return dayStr;
    };

    const buckets = new Map<string, TimeseriesBucket>();
    const getBucket = (key: string): TimeseriesBucket => {
      if (!buckets.has(key)) {
        buckets.set(key, {
          date: key,
          article: 0,
          slideshow: 0,
          ssAutomation: 0,
          allotted: 0,
          published: 0,
        });
      }
      return buckets.get(key)!;
    };

    for (const r of rows) {
      const key = bucketKey(r.date);
      if (key === 'unknown') continue;
      const b = getBucket(key);
      b.allotted++;
      if (r.contentType === 'Article') b.article++;
      else if (r.contentType === 'Slideshow') b.slideshow++;
      else if (r.contentType === 'SS Automation') b.ssAutomation++;
      if (this.countsAsPublished(r)) b.published++;
    }

    return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  async getFunnel(params: MsnFilterParams): Promise<FunnelStage[]> {
    const rows = await this.filter(params);

    const allotted = rows.length;
    const picked = rows.filter(
      (r) => !!r.pickedAt || this.isSubmitted(r),
    ).length;
    const submitted = rows.filter((r) => this.isSubmitted(r)).length;
    const verified = rows.filter(
      (r) => r.editorialStatus === 'Verified' || !!r.verifyEnd,
    ).length;
    const published = rows.filter(
      (r) => this.isPublished(r) || this.isScheduled(r),
    ).length;

    const stages = [
      { stage: 'Allotted', count: allotted },
      { stage: 'Picked', count: picked },
      { stage: 'Submitted', count: submitted },
      { stage: 'Verified', count: verified },
      { stage: 'Published', count: published },
    ];

    return stages.map((s, i) => ({
      ...s,
      percentage:
        stages[0].count > 0
          ? Math.round((s.count / stages[0].count) * 1000) / 10
          : 0,
      dropOff: i > 0 ? stages[i - 1].count - s.count : 0,
    }));
  }

  async getStatusMix(
    params: MsnFilterParams,
  ): Promise<{ publishing: StatusMixEntry[]; editorial: StatusMixEntry[] }> {
    const rows = await this.filter(params);

    const countBy = (
      getStatus: (r: MsnPiece) => string,
    ): StatusMixEntry[] => {
      const map = new Map<string, number>();
      let total = 0;
      for (const r of rows) {
        const s = getStatus(r);
        if (!s || s === 'Unknown') continue;
        map.set(s, (map.get(s) || 0) + 1);
        total++;
      }
      return [...map.entries()]
        .map(([status, count]) => ({
          status,
          count,
          percentage: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.count - a.count);
    };

    return {
      publishing: countBy((r) => r.publishingStatus),
      editorial: countBy((r) => r.editorialStatus),
    };
  }

  async getFeedStats(params: MsnFilterParams): Promise<FeedStats[]> {
    const rows = await this.filter(params);

    const feedMap = new Map<string, FeedStats>();
    const leadTimes = new Map<string, number[]>();

    const getOrCreate = (feed: string): FeedStats => {
      if (!feedMap.has(feed)) {
        feedMap.set(feed, {
          feed,
          allotted: 0,
          produced: 0,
          published: 0,
          publishRate: 0,
          avgLeadTimeHours: 0,
          articles: 0,
          slideshows: 0,
          ssAutomation: 0,
        });
      }
      return feedMap.get(feed)!;
    };

    for (const r of rows) {
      const f = getOrCreate(r.feed);
      f.allotted++;
      if (this.isSubmitted(r)) f.produced++;
      if (this.countsAsPublished(r)) f.published++;
      if (r.contentType === 'Article') f.articles++;
      else if (r.contentType === 'Slideshow') f.slideshows++;
      else if (r.contentType === 'SS Automation') f.ssAutomation++;

      const lt = hoursBetween(r.allottedAt, r.publishedAt);
      if (lt !== null) {
        if (!leadTimes.has(r.feed)) leadTimes.set(r.feed, []);
        leadTimes.get(r.feed)!.push(lt);
      }
    }

    for (const f of feedMap.values()) {
      f.publishRate =
        f.allotted > 0 ? Math.round((f.published / f.allotted) * 1000) / 10 : 0;
      const lt = leadTimes.get(f.feed);
      if (lt?.length) {
        lt.sort((a, b) => a - b);
        f.avgLeadTimeHours = median(lt);
      }
    }

    return [...feedMap.values()].sort((a, b) => b.produced - a.produced);
  }

  async getWriterStats(params: MsnFilterParams): Promise<WriterStats[]> {
    // A writer's pieces are dated by when they picked them up, not when the
    // piece was allotted — work started a day after allotment belongs to the
    // pick day. So the date window filters on the pick date here.
    const rows = await this.filterByAnchor(params, 'picked');

    const wMap = new Map<string, WriterStats>();
    const leadTimes = new Map<string, number[]>();
    const sentBack = new Map<string, number>();

    const getOrCreate = (writer: string): WriterStats => {
      if (!wMap.has(writer)) {
        wMap.set(writer, {
          writer,
          allotted: 0,
          submitted: 0,
          published: 0,
          publishRate: 0,
          sentBackRate: 0,
          avgLeadTimeHours: 0,
          articles: 0,
          slideshows: 0,
          total: 0,
        });
      }
      return wMap.get(writer)!;
    };

    for (const r of rows) {
      if (r.writer === 'Unknown') continue;
      const w = getOrCreate(r.writer);
      w.allotted++;
      w.total++;
      if (this.isSubmitted(r)) w.submitted++;
      if (this.countsAsPublished(r)) w.published++;
      if (r.contentType === 'Article') w.articles++;
      else if (r.contentType === 'Slideshow' || r.contentType === 'SS Automation')
        w.slideshows++;

      if (
        DROPPED_STATUSES.includes(r.publishingStatus) ||
        DROPPED_STATUSES.includes(r.editorialStatus)
      ) {
        sentBack.set(r.writer, (sentBack.get(r.writer) || 0) + 1);
      }

      const lt = hoursBetween(r.allottedAt, r.publishedAt);
      if (lt !== null) {
        if (!leadTimes.has(r.writer)) leadTimes.set(r.writer, []);
        leadTimes.get(r.writer)!.push(lt);
      }
    }

    for (const w of wMap.values()) {
      w.publishRate =
        w.allotted > 0 ? Math.round((w.published / w.allotted) * 1000) / 10 : 0;
      w.sentBackRate =
        w.total > 0
          ? Math.round(((sentBack.get(w.writer) || 0) / w.total) * 1000) / 10
          : 0;
      const lt = leadTimes.get(w.writer);
      if (lt?.length) {
        lt.sort((a, b) => a - b);
        w.avgLeadTimeHours = median(lt);
      }
    }

    return [...wMap.values()].sort((a, b) => b.total - a.total);
  }

  async getEditorStats(params: MsnFilterParams): Promise<EditorStats[]> {
    // An editor's pieces are dated by when they began review (verify start),
    // the editor analogue of the writer's pick — not the allotment day.
    const rows = await this.filterByAnchor(params, 'verify');

    const eMap = new Map<
      string,
      {
        count: number;
        turnarounds: number[];
        sentBack: number;
        types: Set<string>;
      }
    >();

    for (const r of rows) {
      if (!r.editor || r.editor === 'Unknown') continue;
      // PR pieces publish without review — not the editor's work.
      if (this.isPrPublished(r)) continue;
      if (!eMap.has(r.editor)) {
        eMap.set(r.editor, {
          count: 0,
          turnarounds: [],
          sentBack: 0,
          types: new Set(),
        });
      }
      const e = eMap.get(r.editor)!;
      e.count++;
      e.types.add(r.contentType);
      if (
        r.editorialStatus === 'Sent Back' ||
        r.publishingStatus === 'Sent Back'
      )
        e.sentBack++;
      // Editor turnaround = verifying start → end (falls back to submit→publish).
      const ta =
        hoursBetween(r.verifyStart, r.verifyEnd) ??
        hoursBetween(r.submittedAt, r.publishedAt);
      if (ta !== null) e.turnarounds.push(ta);
    }

    return [...eMap.entries()]
      .map(([editor, data]) => {
        data.turnarounds.sort((a, b) => a - b);
        return {
          editor,
          articlesEdited: data.count,
          avgTurnaroundHours: median(data.turnarounds),
          sentBackRate:
            data.count > 0
              ? Math.round((data.sentBack / data.count) * 1000) / 10
              : 0,
          contentTypes: [...data.types],
        };
      })
      .sort((a, b) => b.articlesEdited - a.articlesEdited);
  }

  async getAllotterStats(params: MsnFilterParams): Promise<AllotterStats[]> {
    const rows = await this.filter(params);

    const aMap = new Map<
      string,
      {
        volume: number;
        published: number;
        leadTimes: number[];
        feedCounts: Map<string, number>;
        writerCounts: Map<string, number>;
      }
    >();

    for (const r of rows) {
      if (r.allottedBy === 'Unknown') continue;
      if (!aMap.has(r.allottedBy)) {
        aMap.set(r.allottedBy, {
          volume: 0,
          published: 0,
          leadTimes: [],
          feedCounts: new Map(),
          writerCounts: new Map(),
        });
      }
      const a = aMap.get(r.allottedBy)!;
      a.volume++;
      a.feedCounts.set(r.feed, (a.feedCounts.get(r.feed) || 0) + 1);
      a.writerCounts.set(r.writer, (a.writerCounts.get(r.writer) || 0) + 1);
      if (this.isPublished(r) || this.isScheduled(r)) a.published++;
      const lt = hoursBetween(r.allottedAt, r.publishedAt);
      if (lt !== null) a.leadTimes.push(lt);
    }

    return [...aMap.entries()]
      .map(([allottedBy, data]) => {
        data.leadTimes.sort((a, b) => a - b);
        const topFeed =
          [...data.feedCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ||
          '';
        const topWriter =
          [...data.writerCounts.entries()]
            .filter(([w]) => w !== 'Unknown')
            .sort((a, b) => b[1] - a[1])[0]?.[0] || '';
        return {
          allottedBy,
          volume: data.volume,
          publishedRate:
            data.volume > 0
              ? Math.round((data.published / data.volume) * 1000) / 10
              : 0,
          avgLeadTimeHours: median(data.leadTimes),
          topFeed,
          topWriter,
        };
      })
      .sort((a, b) => b.volume - a.volume);
  }

  async getProduction(params: MsnFilterParams): Promise<ProductionResult> {
    // Each section is dated by its own activity, so fetch the deduped set
    // without a date clause and window each piece by the relevant work day:
    // allotment for allotters, pick for writers, review-start for editors.
    const rows = this.dedupePieces(
      await this.pieceRepo.find({ where: this.buildWhere(params, false) }),
    );

    const zero = (): ProductionCounts => ({
      pieces: 0,
      articles: 0,
      slideshows: 0,
      slides: 0,
    });
    const add = (c: ProductionCounts, r: MsnPiece) => {
      c.pieces++;
      if (r.contentType === 'Article') c.articles++;
      else if (
        r.contentType === 'Slideshow' ||
        r.contentType === 'SS Automation'
      )
        c.slideshows++;
      c.slides += r.slides ?? 0;
    };
    // Edited = the piece cleared review. A published/scheduled piece implies
    // review EXCEPT for PR pieces, which go live without it — those are tracked
    // separately and never counted as "edited".
    const isEdited = (r: MsnPiece) =>
      !!r.verifyEnd ||
      r.editorialStatus === 'Verified' ||
      ((this.isPublished(r) || this.isScheduled(r)) && !this.isPrPublished(r));
    const perDay = (pieces: number, days: Set<string>) =>
      days.size > 0 ? Math.round((pieces / days.size) * 10) / 10 : 0;
    const rate = (n: number, d: number) =>
      d > 0 ? Math.round((n / d) * 1000) / 10 : 0;

    const summary: ProductionSummary = {
      allotted: zero(),
      picked: zero(),
      drafted: zero(),
      edited: zero(),
      prPublished: zero(),
      pickRate: 0,
      draftRate: 0,
      editRate: 0,
      medianWriteHours: 0,
      medianEditHours: 0,
    };
    const writeHours: number[] = [];
    const editHours: number[] = [];

    const allotters = new Map<
      string,
      { counts: ProductionCounts; days: Set<string> }
    >();
    const writers = new Map<
      string,
      {
        allotted: ProductionCounts;
        picked: ProductionCounts;
        drafted: ProductionCounts;
        hours: number[];
        days: Set<string>;
      }
    >();
    const editors = new Map<
      string,
      {
        counts: ProductionCounts;
        pending: number;
        hours: number[];
        days: Set<string>;
      }
    >();

    for (const r of rows) {
      const pr = this.isPrPublished(r);
      const drafted = this.isSubmitted(r);
      // A piece is "picked" once the writer starts it. Anything already
      // submitted/published was necessarily picked, so OR it in — that keeps
      // picked ≥ drafted and the two writer sub-deltas non-negative even when
      // the pick timestamp is missing in the source.
      const picked = !!r.pickedAt || drafted;
      const edited = !pr && isEdited(r);

      // The allotted→picked→drafted→edited funnel is scored as one cohort: every
      // metric below counts pieces ALLOTTED in the window and asks how far each
      // got. Keeping a single denominator (allotted) is what keeps the rates
      // honest — a piece picked/drafted the day after allotment still belongs to
      // its allotment-day cohort, so nothing is double-anchored or inflated. The
      // per-editor table further down stays on the review day (the editor's own
      // work day), which is why verifyDay/verifyIn are still derived.
      const allotDay = r.date;
      const verifyDay = this.anchorDay(r, 'verify');
      const allotIn = this.inRange(allotDay, params);
      const verifyIn = this.inRange(verifyDay, params);

      if (allotIn) {
        add(summary.allotted, r);
        if (picked) add(summary.picked, r);
        if (drafted) add(summary.drafted, r);
        if (edited) add(summary.edited, r);
        if (pr) add(summary.prPublished, r);
      }

      const wh = hoursBetween(r.pickedAt, r.submittedAt);
      if (allotIn && wh !== null) writeHours.push(wh);
      // PR pieces skip review — keep their edit time out of the median.
      const eh = pr ? null : hoursBetween(r.verifyStart, r.verifyEnd);
      if (allotIn && eh !== null) editHours.push(eh);

      if (allotIn && r.allottedBy && r.allottedBy !== 'Unknown') {
        if (!allotters.has(r.allottedBy))
          allotters.set(r.allottedBy, { counts: zero(), days: new Set() });
        const a = allotters.get(r.allottedBy)!;
        add(a.counts, r);
        if (allotDay) a.days.add(allotDay);
      }

      // Writers are scored on the day a piece was ALLOTTED to them, then the
      // shortfall is split two ways: pieces not yet picked up vs pieces picked
      // but not yet submitted. A piece picked the day after allotment still
      // belongs to its allotment-day cohort, so the writer isn't penalised for
      // work that simply hadn't reached them when the day was tallied.
      if (allotIn && r.writer && r.writer !== 'Unknown') {
        if (!writers.has(r.writer))
          writers.set(r.writer, {
            allotted: zero(),
            picked: zero(),
            drafted: zero(),
            hours: [],
            days: new Set(),
          });
        const w = writers.get(r.writer)!;
        add(w.allotted, r);
        if (picked) add(w.picked, r);
        if (drafted) add(w.drafted, r);
        if (allotDay) w.days.add(allotDay);
        if (wh !== null) w.hours.push(wh);
      }

      // PR pieces bypass review, so they aren't an editor's work — skip them
      // from per-editor stats entirely (kept in volume counts above).
      if (verifyIn && r.editor && r.editor !== 'Unknown' && !pr) {
        if (!editors.has(r.editor))
          editors.set(r.editor, {
            counts: zero(),
            pending: 0,
            hours: [],
            days: new Set(),
          });
        const e = editors.get(r.editor)!;
        if (edited) {
          add(e.counts, r);
          if (verifyDay) e.days.add(verifyDay);
        } else {
          e.pending++;
        }
        if (eh !== null) e.hours.push(eh);
      }
    }

    summary.pickRate = rate(summary.picked.pieces, summary.allotted.pieces);
    summary.draftRate = rate(summary.drafted.pieces, summary.allotted.pieces);
    // Edit rate is measured against drafts that are actually eligible for
    // review — PR-published drafts skip it by design, so exclude them.
    summary.editRate = rate(
      summary.edited.pieces,
      summary.drafted.pieces - summary.prPublished.pieces,
    );
    writeHours.sort((a, b) => a - b);
    editHours.sort((a, b) => a - b);
    summary.medianWriteHours = median(writeHours);
    summary.medianEditHours = median(editHours);

    return {
      summary,
      allotters: [...allotters.entries()]
        .map(([name, a]) => ({
          name,
          ...a.counts,
          perDay: perDay(a.counts.pieces, a.days),
        }))
        .sort((a, b) => b.pieces - a.pieces),
      writers: [...writers.entries()]
        .map(([writer, w]) => {
          w.hours.sort((a, b) => a - b);
          return {
            writer,
            allotted: w.allotted,
            picked: w.picked,
            drafted: w.drafted,
            // Two halves of the allotted→drafted shortfall; they sum to
            // deltaPieces (allotted − drafted).
            notPickedPieces: w.allotted.pieces - w.picked.pieces,
            pickedNotDraftedPieces: w.picked.pieces - w.drafted.pieces,
            deltaPieces: w.allotted.pieces - w.drafted.pieces,
            deltaSlides: w.allotted.slides - w.drafted.slides,
            draftRate: rate(w.drafted.pieces, w.allotted.pieces),
            pickRate: rate(w.picked.pieces, w.allotted.pieces),
            medianWriteHours: median(w.hours),
            perDay: perDay(w.drafted.pieces, w.days),
          };
        })
        .sort((a, b) => b.allotted.pieces - a.allotted.pieces),
      editors: [...editors.entries()]
        .map(([editor, e]) => {
          e.hours.sort((a, b) => a - b);
          return {
            editor,
            ...e.counts,
            pending: e.pending,
            medianEditHours: median(e.hours),
            perDay: perDay(e.counts.pieces, e.days),
          };
        })
        .sort((a, b) => b.pieces - a.pieces),
    };
  }

  async getContentMix(
    params: MsnFilterParams,
    granularity: string = 'week',
  ): Promise<ContentMixEntry[]> {
    const rows = await this.filter(params);

    const bucketKey = (dateStr: string | null): string => {
      if (!dateStr) return 'unknown';
      const d = new Date(dateStr);
      const dayStr = d.toISOString().split('T')[0];
      if (granularity === 'month') return dayStr.substring(0, 7);
      const day = d.getUTCDay();
      const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff))
        .toISOString()
        .split('T')[0];
    };

    const buckets = new Map<
      string,
      { article: number; slideshow: number; ssAutomation: number }
    >();

    for (const r of rows) {
      const key = bucketKey(r.date);
      if (key === 'unknown') continue;
      if (!buckets.has(key))
        buckets.set(key, { article: 0, slideshow: 0, ssAutomation: 0 });
      const b = buckets.get(key)!;
      if (r.contentType === 'Article') b.article++;
      else if (r.contentType === 'Slideshow') b.slideshow++;
      else if (r.contentType === 'SS Automation') b.ssAutomation++;
    }

    return [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, counts]) => {
        const total = counts.article + counts.slideshow + counts.ssAutomation;
        return {
          period,
          ...counts,
          articlePct:
            total > 0 ? Math.round((counts.article / total) * 1000) / 10 : 0,
          slideshowPct:
            total > 0 ? Math.round((counts.slideshow / total) * 1000) / 10 : 0,
          ssAutomationPct:
            total > 0
              ? Math.round((counts.ssAutomation / total) * 1000) / 10
              : 0,
        };
      });
  }

  async getHeatmap(
    params: MsnFilterParams,
    type: string = 'calendar',
  ): Promise<HeatmapCell[]> {
    const rows = await this.filter(params);

    if (type === 'feed-writer') {
      const cells = new Map<string, number>();
      for (const r of rows) {
        if (r.feed === 'Unknown' || r.writer === 'Unknown') continue;
        const key = `${r.feed}||${r.writer}`;
        cells.set(key, (cells.get(key) || 0) + 1);
      }
      return [...cells.entries()].map(([key, value]) => {
        const [row, col] = key.split('||');
        return { row, col, value };
      });
    }

    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const cells = new Map<string, number>();
    for (const r of rows) {
      if (!r.date || r.writer === 'Unknown') continue;
      const d = new Date(r.date);
      const dayIdx = d.getUTCDay();
      const day = dayNames[dayIdx === 0 ? 6 : dayIdx - 1];
      const key = `${r.writer}||${day}`;
      cells.set(key, (cells.get(key) || 0) + 1);
    }

    return [...cells.entries()].map(([key, value]) => {
      const [row, col] = key.split('||');
      return { row, col, value };
    });
  }

  private buildDailyBreakdown(
    rows: MsnPiece[],
    getName: (r: MsnPiece) => string,
    anchor: 'allotment' | 'picked' | 'verify' = 'allotment',
  ): DailyBreakdownResult {
    const dayMap = new Map<string, DailyBreakdownEntry>();

    for (const r of rows) {
      const name = getName(r);
      const day = this.anchorDay(r, anchor);
      if (!day || !name || name === 'Unknown') continue;
      const key = `${name}||${day}`;
      if (!dayMap.has(key)) {
        dayMap.set(key, {
          name,
          date: day,
          slides: 0,
          slideshows: 0,
          articles: 0,
          total: 0,
        });
      }
      const entry = dayMap.get(key)!;
      if (r.contentType === 'Article') {
        entry.articles++;
        entry.total++;
      } else if (
        r.contentType === 'Slideshow' ||
        r.contentType === 'SS Automation'
      ) {
        entry.slideshows++;
        entry.slides += r.slides ?? 0;
        entry.total++;
      }
    }

    const daily = [...dayMap.values()].sort(
      (a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name),
    );

    const personMap = new Map<
      string,
      { slides: number; slideshows: number; articles: number; days: Set<string> }
    >();
    for (const d of daily) {
      if (!personMap.has(d.name)) {
        personMap.set(d.name, {
          slides: 0,
          slideshows: 0,
          articles: 0,
          days: new Set(),
        });
      }
      const p = personMap.get(d.name)!;
      p.slides += d.slides;
      p.slideshows += d.slideshows;
      p.articles += d.articles;
      p.days.add(d.date);
    }

    const personalAverages: PersonAverage[] = [...personMap.entries()]
      .map(([name, data]) => {
        const days = Math.max(data.days.size, 1);
        return {
          name,
          avgSlides: Math.round((data.slides / days) * 10) / 10,
          avgSlideshows: Math.round((data.slideshows / days) * 10) / 10,
          avgArticles: Math.round((data.articles / days) * 10) / 10,
          avgTotal:
            Math.round(((data.slideshows + data.articles) / days) * 10) / 10,
          activeDays: data.days.size,
          totalSlides: data.slides,
          totalSlideshows: data.slideshows,
          totalArticles: data.articles,
        };
      })
      .sort((a, b) => b.avgTotal - a.avgTotal);

    const total = Math.max(personalAverages.length, 1);
    const teamAverage = {
      avgSlides:
        Math.round(
          (personalAverages.reduce((s, p) => s + p.avgSlides, 0) / total) * 10,
        ) / 10,
      avgSlideshows:
        Math.round(
          (personalAverages.reduce((s, p) => s + p.avgSlideshows, 0) / total) *
            10,
        ) / 10,
      avgArticles:
        Math.round(
          (personalAverages.reduce((s, p) => s + p.avgArticles, 0) / total) *
            10,
        ) / 10,
      avgTotal:
        Math.round(
          (personalAverages.reduce((s, p) => s + p.avgTotal, 0) / total) * 10,
        ) / 10,
    };

    return { daily, personalAverages, teamAverage };
  }

  async getWriterDailyBreakdown(
    params: MsnFilterParams,
  ): Promise<DailyBreakdownResult> {
    const rows = await this.filterByAnchor(params, 'picked');
    return this.buildDailyBreakdown(rows, (r) => r.writer, 'picked');
  }

  async getEditorDailyBreakdown(
    params: MsnFilterParams,
  ): Promise<DailyBreakdownResult> {
    const rows = await this.filterByAnchor(params, 'verify');
    return this.buildDailyBreakdown(rows, (r) => r.editor, 'verify');
  }

  // ── Pipeline drop-off (replaces cross-sheet leakage) ──

  async getLeakage(params: MsnFilterParams): Promise<LeakageResult> {
    const rows = await this.filter(params);

    const toItem = (r: MsnPiece): LeakageItem => ({
      title: r.title,
      date: r.date || '',
      writer: r.writer,
      feed: r.feed,
      allottedBy: r.allottedBy,
    });

    const allottedNotSubmittedRows = rows.filter(
      (r) => !this.isSubmitted(r) && !DROPPED_STATUSES.includes(r.publishingStatus),
    );
    const submittedNotPublishedRows = rows.filter(
      (r) =>
        this.isSubmitted(r) &&
        !this.isPublished(r) &&
        !this.isScheduled(r) &&
        !DROPPED_STATUSES.includes(r.publishingStatus),
    );

    return {
      allottedNotSubmitted: allottedNotSubmittedRows.slice(0, 100).map(toItem),
      submittedNotPublished: submittedNotPublishedRows.slice(0, 100).map(toItem),
      allottedNotSubmittedCount: allottedNotSubmittedRows.length,
      submittedNotPublishedCount: submittedNotPublishedRows.length,
    };
  }

  // ── Stage durations (lifecycle latency analytics) ──

  async getStageDurations(
    params: MsnFilterParams,
  ): Promise<StageDurationResult> {
    const rows = await this.filter(params);

    const pick: number[] = [];
    const writing: number[] = [];
    const editing: number[] = [];
    const publish: number[] = [];
    const totalLead: number[] = [];

    const byFeed = new Map<
      string,
      { pick: number[]; writing: number[]; editing: number[]; publish: number[]; total: number[] }
    >();
    const byWriter = new Map<
      string,
      { pick: number[]; writing: number[]; editing: number[]; publish: number[]; total: number[] }
    >();

    const bucket = (
      map: Map<string, any>,
      name: string,
    ) => {
      if (!map.has(name))
        map.set(name, { pick: [], writing: [], editing: [], publish: [], total: [] });
      return map.get(name);
    };

    for (const r of rows) {
      const p = hoursBetween(r.allottedAt, r.pickedAt);
      const w = hoursBetween(r.pickedAt, r.submittedAt);
      // PR pieces skip review — keep them out of the editing-stage stats so
      // the bottleneck thresholds reflect genuinely reviewed work.
      const e = this.isPrPublished(r)
        ? null
        : hoursBetween(r.verifyStart, r.verifyEnd);
      const pub = hoursBetween(r.submittedAt, r.publishedAt);
      const tot = hoursBetween(r.allottedAt, r.publishedAt, 30 * 24);

      if (p !== null) pick.push(p);
      if (w !== null) writing.push(w);
      if (e !== null) editing.push(e);
      if (pub !== null) publish.push(pub);
      if (tot !== null) totalLead.push(tot);

      if (r.feed !== 'Unknown') {
        const fb = bucket(byFeed, r.feed);
        if (p !== null) fb.pick.push(p);
        if (w !== null) fb.writing.push(w);
        if (e !== null) fb.editing.push(e);
        if (pub !== null) fb.publish.push(pub);
        if (tot !== null) fb.total.push(tot);
      }
      if (r.writer !== 'Unknown') {
        const wb = bucket(byWriter, r.writer);
        if (p !== null) wb.pick.push(p);
        if (w !== null) wb.writing.push(w);
        if (e !== null) wb.editing.push(e);
        if (pub !== null) wb.publish.push(pub);
        if (tot !== null) wb.total.push(tot);
      }
    }

    const stat = (stage: string, vals: number[]): StageDurationStat => {
      const sorted = [...vals].sort((a, b) => a - b);
      return {
        stage,
        medianHours: median(sorted),
        avgHours: mean(vals),
        p90Hours: percentile(sorted, 90),
        sampleSize: vals.length,
      };
    };

    const stages: StageDurationStat[] = [
      stat('Pick Latency', pick),
      stat('Writing', writing),
      stat('Editing', editing),
      stat('To Publish', publish),
      stat('Total Lead', totalLead),
    ];

    const toEntity = (name: string, b: any): StageDurationByEntity => ({
      name,
      pickLatencyHours: median([...b.pick].sort((a: number, c: number) => a - c)),
      writingHours: median([...b.writing].sort((a: number, c: number) => a - c)),
      editingHours: median([...b.editing].sort((a: number, c: number) => a - c)),
      publishHours: median([...b.publish].sort((a: number, c: number) => a - c)),
      totalHours: median([...b.total].sort((a: number, c: number) => a - c)),
      count: b.total.length,
    });

    const byFeedArr = [...byFeed.entries()]
      .map(([name, b]) => toEntity(name, b))
      .sort((a, b) => b.count - a.count);
    const byWriterArr = [...byWriter.entries()]
      .map(([name, b]) => toEntity(name, b))
      .filter((e) => e.count > 0)
      .sort((a, b) => b.count - a.count);

    return { stages, byFeed: byFeedArr, byWriter: byWriterArr };
  }

  async getRepeatingTitles(
    params: MsnFilterParams,
  ): Promise<RepeatingTitlesResult> {
    const rows = await this.filter(params);

    const titleMap = new Map<
      string,
      {
        title: string;
        writers: Set<string>;
        assignments: {
          writer: string;
          date: string;
          feed: string;
          allottedBy: string;
          status: string;
        }[];
      }
    >();

    for (const r of rows) {
      if (!r.title) continue;
      const key = r.title.toLowerCase().trim();
      if (!key) continue;

      if (!titleMap.has(key)) {
        titleMap.set(key, {
          title: r.title,
          writers: new Set(),
          assignments: [],
        });
      }
      const entry = titleMap.get(key)!;
      entry.writers.add(r.writer);
      entry.assignments.push({
        writer: r.writer,
        date: r.date || '',
        feed: r.feed,
        allottedBy: r.allottedBy,
        status: r.publishingStatus,
      });
    }

    const repeating: RepeatingTitleEntry[] = [];
    for (const entry of titleMap.values()) {
      if (entry.writers.size < 2) continue;
      repeating.push({
        title: entry.title,
        count: entry.assignments.length,
        assignments: entry.assignments.sort((a, b) =>
          a.date.localeCompare(b.date),
        ),
      });
    }

    repeating.sort((a, b) => b.count - a.count);

    return {
      titles: repeating.slice(0, 200),
      totalCount: repeating.length,
    };
  }

  // ── Live stage board: where every WIP piece sits right now ──

  /**
   * Resolve the piece's current pipeline stage, or null when it has left the
   * pipeline (published / scheduled / dropped). `enteredAt` is the timestamp
   * the piece entered its current stage, used for aging.
   */
  private wipStageOf(
    p: MsnPiece,
  ): { key: string; label: string; enteredAt: Date | null } | null {
    if (this.isPublished(p) || this.isScheduled(p) || p.publishedAt)
      return null;
    if (
      DROPPED_STATUSES.includes(p.publishingStatus) ||
      DROPPED_STATUSES.includes(p.editorialStatus)
    )
      return null;

    const verified = p.editorialStatus === 'Verified' || !!p.verifyEnd;
    if (verified) {
      return {
        key: 'ready',
        label: 'Ready to Publish',
        enteredAt: p.verifyEnd ?? p.submittedAt ?? p.allottedAt,
      };
    }
    if (p.verifyStart) {
      return { key: 'review', label: 'In Review', enteredAt: p.verifyStart };
    }
    if (p.submittedAt || p.publishingStatus === 'Submitted') {
      return {
        key: 'awaiting-review',
        label: 'Awaiting Review',
        enteredAt: p.submittedAt ?? p.allottedAt,
      };
    }
    if (p.pickedAt) {
      return { key: 'writing', label: 'Writing', enteredAt: p.pickedAt };
    }
    return {
      key: 'awaiting-pick',
      label: 'Awaiting Pick',
      enteredAt: p.allottedAt,
    };
  }

  private toBoardPiece(
    p: MsnPiece,
    enteredAt: Date | null,
    now: Date,
  ): StageBoardPiece {
    const ageHours = enteredAt
      ? Math.max(
          0,
          Math.round(((now.getTime() - new Date(enteredAt).getTime()) / 3600000) * 10) / 10,
        )
      : 0;
    return {
      id: p.id,
      title: p.title,
      writer: p.writer,
      editor: p.editor,
      feed: p.feed,
      category: p.category,
      contentType: p.contentType,
      ageHours,
      enteredAt: enteredAt ? new Date(enteredAt).toISOString() : null,
    };
  }

  async getStageBoard(params: MsnFilterParams): Promise<StageBoardResult> {
    // The board is a "right now" view — only category/feed filters apply,
    // date range is deliberately ignored.
    const rows = await this.filter({
      categories: params.categories,
      feeds: params.feeds,
    });
    const now = new Date();

    const stageDefs = [
      { key: 'awaiting-pick', label: 'Awaiting Pick' },
      { key: 'writing', label: 'Writing' },
      { key: 'awaiting-review', label: 'Awaiting Review' },
      { key: 'review', label: 'In Review' },
      { key: 'ready', label: 'Ready to Publish' },
    ];
    const buckets = new Map<string, StageBoardPiece[]>(
      stageDefs.map((s) => [s.key, []]),
    );

    let doneLast24h = 0;
    const stuck: StuckPiece[] = [];

    for (const p of rows) {
      const stage = this.wipStageOf(p);
      if (!stage) {
        if (
          p.publishedAt &&
          now.getTime() - new Date(p.publishedAt).getTime() <= 86400000
        )
          doneLast24h++;
        continue;
      }
      const piece = this.toBoardPiece(p, stage.enteredAt, now);
      buckets.get(stage.key)!.push(piece);
      stuck.push({ ...piece, stage: stage.label, stageKey: stage.key });
    }

    const stages: StageBoardStage[] = stageDefs.map(({ key, label }) => {
      const pieces = buckets
        .get(key)!
        .sort((a, b) => b.ageHours - a.ageHours);
      const ages = pieces
        .map((p) => p.ageHours)
        .filter((a) => a > 0)
        .sort((a, b) => a - b);
      return {
        key,
        label,
        count: pieces.length,
        medianAgeHours: median(ages),
        oldestAgeHours: ages.length ? ages[ages.length - 1] : 0,
        pieces: pieces.slice(0, 12),
      };
    });

    stuck.sort((a, b) => b.ageHours - a.ageHours);

    return {
      asOf: now.toISOString(),
      totalWip: stuck.length,
      doneLast24h,
      stages,
      stuck: stuck.slice(0, 20),
    };
  }

  // ── People availability: roster × active assignments ──

  /** "Today" weekday in IST — the team's local day, not the server's. */
  private istWeekday(now: Date): string {
    const days = [
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ];
    const ist = new Date(now.getTime() + 5.5 * 3600000);
    return days[ist.getUTCDay()];
  }

  async getPeopleAvailability(): Promise<AvailabilityResult> {
    const [rosterRows, rawPieces] = await Promise.all([
      this.rosterRepo.find(),
      this.pieceRepo.find(),
    ]);
    // Dedup re-allotments so a duplicated piece doesn't double-count a
    // person's active workload.
    const pieces = this.dedupePieces(rawPieces);
    const now = new Date();
    const weekdayToday = this.istWeekday(now);

    // Collapse roster rows (one per division/feed/role) into people.
    interface RosterPerson {
      name: string;
      divisions: Set<string>;
      feeds: Set<string>;
      roles: Set<string>;
      weekoff: string;
    }
    const people = new Map<string, RosterPerson>();
    for (const r of rosterRows) {
      const key = r.name.trim().toLowerCase();
      if (!key) continue;
      if (!people.has(key)) {
        people.set(key, {
          name: r.name.trim(),
          divisions: new Set(),
          feeds: new Set(),
          roles: new Set(),
          weekoff: '',
        });
      }
      const p = people.get(key)!;
      if (r.division && r.division !== 'Unknown') p.divisions.add(r.division);
      if (r.feed && r.feed !== 'Unknown') p.feeds.add(r.feed);
      if (r.role) p.roles.add(r.role);
      if (r.weekoff && !p.weekoff) p.weekoff = r.weekoff;
    }

    // Name resolver: sheet1 often uses full names where the roster has first
    // names (and vice versa). Try exact, then unique-first-token, then unique
    // prefix containment.
    const byFirstToken = new Map<string, string[]>();
    for (const key of people.keys()) {
      const first = key.split(/\s+/)[0];
      if (!byFirstToken.has(first)) byFirstToken.set(first, []);
      byFirstToken.get(first)!.push(key);
    }
    const resolveCache = new Map<string, string | null>();
    const resolve = (rawName: string): string | null => {
      const norm = rawName.trim().toLowerCase();
      if (!norm || norm === 'unknown') return null;
      if (resolveCache.has(norm)) return resolveCache.get(norm)!;

      let match: string | null = null;
      if (people.has(norm)) {
        match = norm;
      } else {
        const first = norm.split(/\s+/)[0];
        const candidates = byFirstToken.get(first) ?? [];
        if (candidates.length === 1) {
          match = candidates[0];
        } else {
          // last resort: a roster name that is a prefix of the piece name
          const prefixed = [...people.keys()].filter(
            (k) => norm.startsWith(k + ' ') || k.startsWith(norm + ' '),
          );
          if (prefixed.length === 1) match = prefixed[0];
        }
      }
      resolveCache.set(norm, match);
      return match;
    };

    // Active workload from WIP pieces.
    const writing = new Map<string, number>(); // resolved key or raw name
    const editing = new Map<string, number>();
    const publishedLast7 = new Map<string, number>();
    const unmatchedNames = new Map<
      string,
      { name: string; writing: number; editing: number; categories: Set<string> }
    >();

    const bump = (map: Map<string, number>, key: string) =>
      map.set(key, (map.get(key) || 0) + 1);

    const trackUnmatched = (
      rawName: string,
      kind: 'writing' | 'editing',
      category: string,
    ) => {
      const norm = rawName.trim().toLowerCase();
      if (!unmatchedNames.has(norm)) {
        unmatchedNames.set(norm, {
          name: rawName.trim(),
          writing: 0,
          editing: 0,
          categories: new Set(),
        });
      }
      const u = unmatchedNames.get(norm)!;
      u[kind]++;
      if (category && category !== 'Unknown') u.categories.add(category);
    };

    for (const p of pieces) {
      // published in the last 7 days → recent output signal
      if (
        p.publishedAt &&
        now.getTime() - new Date(p.publishedAt).getTime() <= 7 * 86400000 &&
        p.writer !== 'Unknown'
      ) {
        const k = resolve(p.writer);
        if (k) bump(publishedLast7, k);
      }

      const stage = this.wipStageOf(p);
      if (!stage) continue;

      // Writer owns the piece until it is submitted; editor owns it from
      // submission until review completes.
      const writerActive =
        stage.key === 'awaiting-pick' || stage.key === 'writing';
      const editorActive =
        stage.key === 'awaiting-review' || stage.key === 'review';

      if (writerActive && p.writer !== 'Unknown') {
        const k = resolve(p.writer);
        if (k) bump(writing, k);
        else trackUnmatched(p.writer, 'writing', p.category);
      }
      if (editorActive && p.editor && p.editor !== 'Unknown') {
        const k = resolve(p.editor);
        if (k) bump(editing, k);
        else trackUnmatched(p.editor, 'editing', p.category);
      }
    }

    const result: PersonAvailability[] = [...people.entries()].map(
      ([key, p]) => {
        const activeWriting = writing.get(key) || 0;
        const activeEditing = editing.get(key) || 0;
        const activePieces = activeWriting + activeEditing;
        const isWeekoffToday = p.weekoff === weekdayToday;
        return {
          name: p.name,
          divisions: [...p.divisions].sort(),
          feeds: [...p.feeds].sort(),
          roles: [...p.roles].sort(),
          weekoff: p.weekoff,
          isWeekoffToday,
          activeWriting,
          activeEditing,
          activePieces,
          publishedLast7Days: publishedLast7.get(key) || 0,
          status: isWeekoffToday ? 'weekoff' : activePieces > 0 ? 'busy' : 'free',
          inRoster: true,
        };
      },
    );
    result.sort(
      (a, b) => b.activePieces - a.activePieces || a.name.localeCompare(b.name),
    );

    // Division bandwidth (a person assigned to N divisions counts in each).
    const divMap = new Map<string, DivisionBandwidth>();
    for (const person of result) {
      for (const div of person.divisions.length
        ? person.divisions
        : ['Unassigned']) {
        if (!divMap.has(div)) {
          divMap.set(div, {
            division: div,
            total: 0,
            busy: 0,
            free: 0,
            weekoffToday: 0,
            utilization: 0,
          });
        }
        const d = divMap.get(div)!;
        d.total++;
        if (person.status === 'weekoff') d.weekoffToday++;
        else if (person.status === 'busy') d.busy++;
        else d.free++;
      }
    }
    for (const d of divMap.values()) {
      const available = d.total - d.weekoffToday;
      d.utilization =
        available > 0 ? Math.round((d.busy / available) * 1000) / 10 : 0;
    }

    const unmatchedActive: PersonAvailability[] = [...unmatchedNames.values()]
      .map((u) => ({
        name: u.name,
        divisions: [...u.categories].sort(),
        feeds: [],
        roles: [],
        weekoff: '',
        isWeekoffToday: false,
        activeWriting: u.writing,
        activeEditing: u.editing,
        activePieces: u.writing + u.editing,
        publishedLast7Days: 0,
        status: 'busy' as const,
        inRoster: false,
      }))
      .sort((a, b) => b.activePieces - a.activePieces);

    return {
      asOf: now.toISOString(),
      weekdayToday,
      people: result,
      divisions: [...divMap.values()].sort((a, b) => b.total - a.total),
      unmatchedActive,
    };
  }

  // ── Category (division) split with outcomes ──

  async getCategorySplit(
    params: MsnFilterParams,
  ): Promise<CategorySplitEntry[]> {
    const rows = await this.filter(params);

    const map = new Map<string, CategorySplitEntry>();
    for (const r of rows) {
      const cat = r.category && r.category !== 'Unknown' ? r.category : 'Other';
      if (!map.has(cat)) {
        map.set(cat, {
          category: cat,
          total: 0,
          published: 0,
          scheduled: 0,
          wip: 0,
          dropped: 0,
        });
      }
      const e = map.get(cat)!;
      e.total++;
      if (this.isPublished(r)) e.published++;
      else if (this.isScheduled(r)) e.scheduled++;
      else if (
        DROPPED_STATUSES.includes(r.publishingStatus) ||
        DROPPED_STATUSES.includes(r.editorialStatus)
      )
        e.dropped++;
      else e.wip++;
    }

    return [...map.values()].sort((a, b) => b.total - a.total);
  }

  // ── Insights: content + personnel decision support ──

  /** Weekday (Mon-first) and hour of a timestamp in IST. */
  private istCell(d: Date): { weekday: string; hour: number } {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const ist = new Date(new Date(d).getTime() + 5.5 * 3600000);
    return { weekday: names[ist.getUTCDay()], hour: ist.getUTCHours() };
  }

  private isDropped(r: MsnPiece): boolean {
    return (
      DROPPED_STATUSES.includes(r.publishingStatus) ||
      DROPPED_STATUSES.includes(r.editorialStatus)
    );
  }

  async getInsights(params: MsnFilterParams): Promise<InsightsResult> {
    const rows = await this.filter(params);
    const now = new Date();
    const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    // ── 1. Content type performance ──
    const ctMap = new Map<
      string,
      {
        total: number;
        published: number;
        dropped: number;
        cycles: number[];
        writes: number[];
        slides: number[];
      }
    >();
    for (const r of rows) {
      const ct = r.contentType !== 'Unknown' ? r.contentType : 'Other';
      if (!ctMap.has(ct)) {
        ctMap.set(ct, {
          total: 0,
          published: 0,
          dropped: 0,
          cycles: [],
          writes: [],
          slides: [],
        });
      }
      const c = ctMap.get(ct)!;
      c.total++;
      if (this.countsAsPublished(r)) c.published++;
      if (this.isDropped(r)) c.dropped++;
      const cycle = hoursBetween(r.allottedAt, r.publishedAt, 30 * 24);
      if (cycle !== null) c.cycles.push(cycle);
      const write = hoursBetween(r.pickedAt, r.submittedAt);
      if (write !== null) c.writes.push(write);
      if (r.slides !== null && r.slides > 0) c.slides.push(r.slides);
    }
    const contentTypes: ContentTypeInsight[] = [...ctMap.entries()]
      .map(([contentType, c]) => ({
        contentType,
        total: c.total,
        published: c.published,
        dropped: c.dropped,
        publishRate:
          c.total > 0 ? Math.round((c.published / c.total) * 1000) / 10 : 0,
        dropRate:
          c.total > 0 ? Math.round((c.dropped / c.total) * 1000) / 10 : 0,
        medianCycleHours: median([...c.cycles].sort((a, b) => a - b)),
        medianWriteHours: median([...c.writes].sort((a, b) => a - b)),
        avgSlides: c.slides.length ? mean(c.slides) : null,
      }))
      .sort((a, b) => b.total - a.total);

    // ── 2. Weekday rhythm (allotted by sheet date, published by IST publish time) ──
    const wdMap = new Map<
      string,
      { allotted: number; published: number; cycles: number[] }
    >(WEEKDAYS.map((w) => [w, { allotted: 0, published: 0, cycles: [] }]));
    for (const r of rows) {
      if (r.date) {
        const d = new Date(r.date);
        const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const wd = names[d.getUTCDay()];
        const b = wdMap.get(wd)!;
        b.allotted++;
        const cycle = hoursBetween(r.allottedAt, r.publishedAt, 30 * 24);
        if (cycle !== null) b.cycles.push(cycle);
      }
      if (r.publishedAt) {
        const { weekday } = this.istCell(r.publishedAt);
        wdMap.get(weekday)!.published++;
      }
    }
    const weekdayPattern: WeekdayPatternEntry[] = WEEKDAYS.map((weekday) => {
      const b = wdMap.get(weekday)!;
      return {
        weekday,
        allotted: b.allotted,
        published: b.published,
        medianCycleHours: median([...b.cycles].sort((a, b2) => a - b2)),
      };
    });

    // ── 3. Publish-hour heatmap (IST) ──
    const heatCells = new Map<string, number>();
    for (const r of rows) {
      if (!r.publishedAt) continue;
      const { weekday, hour } = this.istCell(r.publishedAt);
      const key = `${weekday}|${hour}`;
      heatCells.set(key, (heatCells.get(key) || 0) + 1);
    }
    const publishHeatmap: PublishHeatCell[] = [...heatCells.entries()].map(
      ([key, count]) => {
        const [weekday, hour] = key.split('|');
        return { weekday, hour: Number(hour), count };
      },
    );

    // ── 4. Drop autopsy: where killed pieces died ──
    const stageOfDeath = (r: MsnPiece): string => {
      if (r.verifyEnd || r.editorialStatus === 'Verified') return 'After review';
      if (r.verifyStart) return 'In review';
      if (r.submittedAt) return 'Awaiting review';
      if (r.pickedAt) return 'While writing';
      return 'Never picked';
    };
    const dropStages = new Map<string, number>();
    const dropByCat = new Map<string, { dropped: number; total: number }>();
    const dropByFeed = new Map<string, { dropped: number; total: number }>();
    let totalDropped = 0;
    const bumpGroup = (
      map: Map<string, { dropped: number; total: number }>,
      name: string,
      dropped: boolean,
    ) => {
      if (!map.has(name)) map.set(name, { dropped: 0, total: 0 });
      const g = map.get(name)!;
      g.total++;
      if (dropped) g.dropped++;
    };
    for (const r of rows) {
      const dropped = this.isDropped(r);
      if (r.category !== 'Unknown') bumpGroup(dropByCat, r.category, dropped);
      if (r.feed !== 'Unknown') bumpGroup(dropByFeed, r.feed, dropped);
      if (!dropped) continue;
      totalDropped++;
      const stage = stageOfDeath(r);
      dropStages.set(stage, (dropStages.get(stage) || 0) + 1);
    }
    const stageOrder = [
      'Never picked',
      'While writing',
      'Awaiting review',
      'In review',
      'After review',
    ];
    const byStage: DropStageEntry[] = stageOrder
      .filter((s) => dropStages.has(s))
      .map((stage) => ({ stage, count: dropStages.get(stage)! }));
    const toGroups = (
      map: Map<string, { dropped: number; total: number }>,
    ): DropByGroup[] =>
      [...map.entries()]
        .map(([name, g]) => ({
          name,
          dropped: g.dropped,
          total: g.total,
          dropRate:
            g.total > 0 ? Math.round((g.dropped / g.total) * 1000) / 10 : 0,
        }))
        .filter((g) => g.dropped > 0)
        .sort((a, b) => b.dropped - a.dropped)
        .slice(0, 8);
    const dropAnalysis: DropAnalysis = {
      totalDropped,
      dropRate:
        rows.length > 0
          ? Math.round((totalDropped / rows.length) * 1000) / 10
          : 0,
      byStage,
      byCategory: toGroups(dropByCat),
      byFeed: toGroups(dropByFeed),
    };

    // ── 5. Writer quadrant: volume × write speed × publish rate ──
    const wqMap = new Map<
      string,
      { pieces: number; published: number; dropped: number; writes: number[] }
    >();
    for (const r of rows) {
      if (r.writer === 'Unknown') continue;
      if (!wqMap.has(r.writer)) {
        wqMap.set(r.writer, {
          pieces: 0,
          published: 0,
          dropped: 0,
          writes: [],
        });
      }
      const w = wqMap.get(r.writer)!;
      w.pieces++;
      if (this.countsAsPublished(r)) w.published++;
      if (this.isDropped(r)) w.dropped++;
      const wt = hoursBetween(r.pickedAt, r.submittedAt);
      if (wt !== null) w.writes.push(wt);
    }
    const writerQuadrant: WriterQuadrantEntry[] = [...wqMap.entries()]
      .filter(([, w]) => w.pieces >= 3 && w.writes.length >= 1)
      .map(([writer, w]) => ({
        writer,
        pieces: w.pieces,
        medianWriteHours: median([...w.writes].sort((a, b) => a - b)),
        publishRate:
          w.pieces > 0 ? Math.round((w.published / w.pieces) * 1000) / 10 : 0,
        sentBackRate:
          w.pieces > 0 ? Math.round((w.dropped / w.pieces) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.pieces - a.pieces);

    // ── 6. Writer × editor pair matrix ──
    const pairMap = new Map<
      string,
      { pieces: number; reviews: number[]; sentBacks: number }
    >();
    for (const r of rows) {
      if (r.writer === 'Unknown' || !r.editor || r.editor === 'Unknown')
        continue;
      const key = `${r.writer}||${r.editor}`;
      if (!pairMap.has(key)) {
        pairMap.set(key, { pieces: 0, reviews: [], sentBacks: 0 });
      }
      const p = pairMap.get(key)!;
      p.pieces++;
      if (
        r.editorialStatus === 'Sent Back' ||
        r.publishingStatus === 'Sent Back'
      )
        p.sentBacks++;
      const rt =
        hoursBetween(r.verifyStart, r.verifyEnd) ??
        hoursBetween(r.submittedAt, r.verifyEnd);
      if (rt !== null) p.reviews.push(rt);
    }
    const pairMatrix: PairMatrixEntry[] = [...pairMap.entries()]
      .filter(([, p]) => p.pieces >= 2)
      .map(([key, p]) => {
        const [writer, editor] = key.split('||');
        return {
          writer,
          editor,
          pieces: p.pieces,
          medianReviewHours: median([...p.reviews].sort((a, b) => a - b)),
          sentBacks: p.sentBacks,
        };
      })
      .sort((a, b) => b.pieces - a.pieces)
      .slice(0, 30);

    // ── 7. Momentum: 6 rolling 7-day publish windows per writer ──
    // Deliberately ignores the date filter (it's a trailing-42-day view);
    // category filter still applies.
    const momentumRows = await this.filter({ categories: params.categories });
    const WINDOW = 7 * 86400000;
    const windowStart = (i: number) => now.getTime() - (6 - i) * WINDOW;
    const moMap = new Map<string, number[]>();
    for (const r of momentumRows) {
      if (!r.publishedAt || r.writer === 'Unknown') continue;
      const t = new Date(r.publishedAt).getTime();
      if (t < windowStart(0) || t > now.getTime()) continue;
      const idx = Math.min(5, Math.floor((t - windowStart(0)) / WINDOW));
      if (!moMap.has(r.writer)) moMap.set(r.writer, [0, 0, 0, 0, 0, 0]);
      moMap.get(r.writer)![idx]++;
    }
    const momentum: MomentumEntry[] = [...moMap.entries()]
      .map(([name, weekly]) => {
        const total = weekly.reduce((a, b) => a + b, 0);
        const prior = mean(weekly.slice(0, 5));
        const trendPct = this.calcDelta(weekly[5], prior);
        return {
          name,
          weekly,
          total,
          trendPct,
          direction:
            trendPct > 15 ? ('up' as const) : trendPct < -15 ? ('down' as const) : ('flat' as const),
        };
      })
      .filter((m) => m.total >= 3)
      .sort((a, b) => b.trendPct - a.trendPct);

    // ── 8. Division load vs free capacity ──
    const availability = await this.getPeopleAvailability();
    const divLoad = new Map<string, { published: number; writers: Set<string> }>();
    for (const r of rows) {
      const cat = r.category !== 'Unknown' ? r.category : 'Other';
      if (!divLoad.has(cat))
        divLoad.set(cat, { published: 0, writers: new Set() });
      const d = divLoad.get(cat)!;
      if (this.countsAsPublished(r)) d.published++;
      if (r.writer !== 'Unknown') d.writers.add(r.writer);
    }
    const divisionLoad: DivisionLoadEntry[] = [...divLoad.entries()]
      .map(([division, d]) => {
        const bandwidth = availability.divisions.find(
          (b) => b.division === division,
        );
        const activeWriters = d.writers.size;
        return {
          division,
          published: d.published,
          activeWriters,
          perWriter:
            activeWriters > 0
              ? Math.round((d.published / activeWriters) * 10) / 10
              : 0,
          freePeople: bandwidth?.free ?? 0,
          weekoffToday: bandwidth?.weekoffToday ?? 0,
        };
      })
      .sort((a, b) => b.published - a.published);

    return {
      asOf: now.toISOString(),
      contentTypes,
      weekdayPattern,
      publishHeatmap,
      dropAnalysis,
      writerQuadrant,
      pairMatrix,
      momentum,
      divisionLoad,
    };
  }

  // ── Moderation coverage: production titles × moderation tool log ──

  /** Date-only string in IST for bucketing/filtering check timestamps. */
  private istDateStr(d: Date): string {
    return new Date(new Date(d).getTime() + 5.5 * 3600000)
      .toISOString()
      .slice(0, 10);
  }

  async getModeration(params: MsnFilterParams): Promise<ModerationResult> {
    const [pieces, modRows] = await Promise.all([
      this.filter(params),
      this.moderationRepo.find(),
    ]);
    const now = new Date();
    const DAY = 86400000;

    // Latest check per normalized title (across the full moderation history —
    // staleness is always relative to "now", not the selected period).
    const checksByTitle = new Map<
      string,
      { lastCheckedAt: Date; count: number }
    >();
    for (const m of modRows) {
      if (!m.titleNorm || !m.checkedAt) continue;
      const at = new Date(m.checkedAt);
      const cur = checksByTitle.get(m.titleNorm);
      if (!cur) {
        checksByTitle.set(m.titleNorm, { lastCheckedAt: at, count: 1 });
      } else {
        cur.count++;
        if (at > cur.lastCheckedAt) cur.lastCheckedAt = at;
      }
    }

    // Bucket every eligible production piece. Dropped pieces are excluded —
    // killed work doesn't need moderation.
    const unmoderated: UnmoderatedPiece[] = [];
    let moderatedRecent = 0;
    let over2w = 0;
    let overMonth = 0;
    let never = 0;
    let publishedUnmoderated = 0;
    const byFeedMap = new Map<string, ModerationGroupCount>();
    const byCatMap = new Map<string, ModerationGroupCount>();
    let totalPieces = 0;

    const bumpGroup = (
      map: Map<string, ModerationGroupCount>,
      name: string,
      bucket: ModerationBucket,
    ) => {
      if (!map.has(name)) map.set(name, { name, never: 0, stale: 0, total: 0 });
      const g = map.get(name)!;
      g.total++;
      if (bucket === 'never') g.never++;
      else g.stale++;
    };

    for (const p of pieces) {
      if (!p.title?.trim()) continue;
      if (
        DROPPED_STATUSES.includes(p.publishingStatus) ||
        DROPPED_STATUSES.includes(p.editorialStatus)
      )
        continue;
      totalPieces++;

      const norm = normalizeTitleKey(p.title);
      const check = checksByTitle.get(norm);

      let bucket: ModerationBucket | null = null;
      let daysSinceCheck: number | null = null;
      if (!check) {
        bucket = 'never';
        never++;
      } else {
        daysSinceCheck =
          Math.round(
            ((now.getTime() - check.lastCheckedAt.getTime()) / DAY) * 10,
          ) / 10;
        if (daysSinceCheck > 30) {
          bucket = 'over-month';
          overMonth++;
        } else if (daysSinceCheck > 14) {
          bucket = 'over-2w';
          over2w++;
        } else {
          moderatedRecent++;
        }
      }

      if (!bucket) continue;

      const isPublished = this.isPublished(p) || this.isScheduled(p);
      if (isPublished) publishedUnmoderated++;
      bumpGroup(byFeedMap, p.feed !== 'Unknown' ? p.feed : 'Other', bucket);
      bumpGroup(
        byCatMap,
        p.category !== 'Unknown' ? p.category : 'Other',
        bucket,
      );

      unmoderated.push({
        id: p.id,
        title: p.title,
        writer: p.writer,
        allottedBy: p.allottedBy,
        feed: p.feed,
        category: p.category,
        contentType: p.contentType,
        publishingStatus: p.publishingStatus,
        date: p.date,
        lastCheckedAt: check ? check.lastCheckedAt.toISOString() : null,
        daysSinceCheck,
        checkCount: check?.count ?? 0,
        bucket,
        isPublished,
      });
    }

    // Severity first (never → over-month → over-2w), then staleness.
    const severity: Record<ModerationBucket, number> = {
      never: 0,
      'over-month': 1,
      'over-2w': 2,
    };
    unmoderated.sort(
      (a, b) =>
        severity[a.bucket] - severity[b.bucket] ||
        (b.daysSinceCheck ?? Infinity) - (a.daysSinceCheck ?? Infinity) ||
        (b.date ?? '').localeCompare(a.date ?? ''),
    );

    // ── Moderation-tool activity, scoped to the selected period ──
    const inRange = (d: Date | null): boolean => {
      if (!d) return false;
      const day = this.istDateStr(new Date(d));
      if (params.startDate && day < params.startDate) return false;
      if (params.endDate && day > params.endDate) return false;
      return true;
    };
    const activityRows = modRows.filter((m) => inRange(m.checkedAt));

    // Per-moderator stats
    const modMap = new Map<
      string,
      {
        checks: number;
        titles: Set<string>;
        passed: number;
        risks: number[];
        lastCheckAt: Date | null;
        last7d: number;
      }
    >();
    // Timeline + rechecks + fail dimensions
    const timelineMap = new Map<string, ModerationTimelinePoint>();
    const recheckMap = new Map<
      string,
      {
        title: string;
        count: number;
        users: Set<string>;
        lastCheckedAt: Date | null;
        lastResult: boolean;
        riskRating: number | null;
      }
    >();
    const dims = [
      { key: 'tbScore' as const, label: 'Title/Body' },
      { key: 'legalScore' as const, label: 'Legal' },
      { key: 'feedScore' as const, label: 'Feed Fit' },
      { key: 'subjectiveScore' as const, label: 'Subjective' },
    ];
    const dimCounts = new Map<string, { fails: number; evaluated: number }>(
      dims.map((d) => [d.label, { fails: 0, evaluated: 0 }]),
    );
    let passedTotal = 0;
    const riskAll: number[] = [];

    for (const m of activityRows) {
      // moderators
      const user = m.checkedBy || 'Unknown';
      if (!modMap.has(user)) {
        modMap.set(user, {
          checks: 0,
          titles: new Set(),
          passed: 0,
          risks: [],
          lastCheckAt: null,
          last7d: 0,
        });
      }
      const u = modMap.get(user)!;
      u.checks++;
      u.titles.add(m.titleNorm);
      if (m.overallResult) u.passed++;
      if (m.riskRating !== null) u.risks.push(m.riskRating);
      const at = m.checkedAt ? new Date(m.checkedAt) : null;
      if (at && (!u.lastCheckAt || at > u.lastCheckAt)) u.lastCheckAt = at;
      if (at && now.getTime() - at.getTime() <= 7 * DAY) u.last7d++;

      if (m.overallResult) passedTotal++;
      if (m.riskRating !== null) riskAll.push(m.riskRating);

      // timeline
      if (at) {
        const day = this.istDateStr(at);
        if (!timelineMap.has(day)) {
          timelineMap.set(day, { date: day, checks: 0, passed: 0, failed: 0 });
        }
        const t = timelineMap.get(day)!;
        t.checks++;
        if (m.overallResult) t.passed++;
        else t.failed++;
      }

      // rechecks
      if (m.titleNorm) {
        if (!recheckMap.has(m.titleNorm)) {
          recheckMap.set(m.titleNorm, {
            title: m.title,
            count: 0,
            users: new Set(),
            lastCheckedAt: null,
            lastResult: false,
            riskRating: null,
          });
        }
        const r = recheckMap.get(m.titleNorm)!;
        r.count++;
        r.users.add(user);
        if (at && (!r.lastCheckedAt || at >= r.lastCheckedAt)) {
          r.lastCheckedAt = at;
          r.lastResult = m.overallResult;
          if (m.riskRating !== null) r.riskRating = m.riskRating;
        }
      }

      // fail dimensions (SKIP / blank = not evaluated)
      for (const d of dims) {
        const v = m[d.key];
        if (v !== 'PASS' && v !== 'FAIL') continue;
        const c = dimCounts.get(d.label)!;
        c.evaluated++;
        if (v === 'FAIL') c.fails++;
      }
    }

    const moderators: ModeratorStat[] = [...modMap.entries()]
      .map(([user, u]) => ({
        user,
        checks: u.checks,
        distinctTitles: u.titles.size,
        passRate:
          u.checks > 0 ? Math.round((u.passed / u.checks) * 1000) / 10 : 0,
        avgRisk: u.risks.length ? mean(u.risks) : null,
        lastCheckAt: u.lastCheckAt?.toISOString() ?? null,
        checksLast7d: u.last7d,
      }))
      .sort((a, b) => b.checks - a.checks);

    const rechecks: RecheckEntry[] = [...recheckMap.values()]
      .filter((r) => r.count > 1)
      .map((r) => ({
        title: r.title,
        count: r.count,
        users: [...r.users].slice(0, 5),
        lastCheckedAt: r.lastCheckedAt?.toISOString() ?? null,
        lastResult: r.lastResult,
        riskRating: r.riskRating,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const timeline = [...timelineMap.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-60);

    const failDimensions: FailDimensionEntry[] = dims.map((d) => {
      const c = dimCounts.get(d.label)!;
      return {
        dimension: d.label,
        fails: c.fails,
        evaluated: c.evaluated,
        failRate:
          c.evaluated > 0
            ? Math.round((c.fails / c.evaluated) * 1000) / 10
            : 0,
      };
    });

    const distinctTitlesChecked = new Set(
      activityRows.map((m) => m.titleNorm).filter(Boolean),
    ).size;

    return {
      asOf: now.toISOString(),
      summary: {
        totalPieces,
        moderatedRecent,
        over2w,
        overMonth,
        never,
        unmoderatedTotal: never + over2w + overMonth,
        coverageRate:
          totalPieces > 0
            ? Math.round((moderatedRecent / totalPieces) * 1000) / 10
            : 0,
        publishedUnmoderated,
        totalChecks: activityRows.length,
        distinctTitlesChecked,
        passRate:
          activityRows.length > 0
            ? Math.round((passedTotal / activityRows.length) * 1000) / 10
            : 0,
        avgRisk: riskAll.length ? mean(riskAll) : null,
      },
      unmoderated: unmoderated.slice(0, 500),
      byFeed: [...byFeedMap.values()].sort((a, b) => b.total - a.total),
      byCategory: [...byCatMap.values()].sort((a, b) => b.total - a.total),
      moderators,
      rechecks,
      timeline,
      failDimensions,
    };
  }
  // ── Duplicate allotments: same title handed out more than once ──

  async getDuplicates(params: MsnFilterParams): Promise<DuplicatesResult> {
    // Duplicates view needs the raw rows — that's the whole point.
    const rows = await this.filterRaw(params);
    const now = new Date();

    // Group every allotment by canonical piece identity (uniquePieceId) — a
    // re-allotment keeps the same uniquePieceId, so this catches it even when
    // the title was edited, and won't false-flag two distinct pieces that
    // happen to share a title. Rows with a blank uniquePieceId fall back to
    // normalized title. Dropped/trashed rows stay in — a duplicate that later
    // got trashed was still a duplicate allotment (status shows how it ended).
    type TempAllot = DuplicateAllotment & {
      ts: number;
      title: string;
      category: string;
    };
    const groups = new Map<string, TempAllot[]>();

    for (const r of rows) {
      if (!r.title?.trim()) continue;
      const upid = r.uniquePieceId?.trim();
      const key = upid ? `upid:${upid}` : `title:${normalizeTitleKey(r.title)}`;
      if (key === 'title:') continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({
        date: r.date,
        allottedAt: r.allottedAt ? new Date(r.allottedAt).toISOString() : null,
        writer: r.writer,
        allottedBy: r.allottedBy,
        feed: r.feed,
        status:
          r.publishingStatus !== 'Unknown' ? r.publishingStatus : 'In progress',
        ts: r.allottedAt
          ? new Date(r.allottedAt).getTime()
          : r.date
            ? new Date(r.date).getTime()
            : Number.MAX_SAFE_INTEGER,
        title: r.title,
        category: r.category !== 'Unknown' ? r.category : 'Other',
      });
    }

    const titles: DuplicateTitleEntry[] = [];
    const byCategory = new Map<string, DuplicateGroupAgg>();
    const byFeed = new Map<string, DuplicateGroupAgg>();
    const byAllotter = new Map<string, DuplicateGroupAgg>();
    let extraAllotments = 0;
    let affectedPieces = 0;
    let crossFeedGroups = 0;

    const bump = (
      map: Map<string, DuplicateGroupAgg>,
      name: string,
      extras: number,
    ) => {
      if (!map.has(name)) map.set(name, { name, groups: 0, extras: 0 });
      const g = map.get(name)!;
      g.groups++;
      g.extras += extras;
    };

    for (const [, allots] of groups) {
      if (allots.length < 2) continue;

      allots.sort((a, b) => a.ts - b.ts);
      // Display title/category come from the earliest (original) allotment.
      const displayTitle = allots[0].title;
      const category = allots[0].category;
      const [first, ...repeats] = allots.map(
        ({ ts: _ts, title: _t, category: _c, ...a }) => a,
      );
      const extras = repeats.length;
      const feeds = new Set(allots.map((a) => a.feed));
      const writers = new Set(
        allots.map((a) => a.writer).filter((w) => w !== 'Unknown'),
      );
      const crossFeed = feeds.size > 1;

      extraAllotments += extras;
      affectedPieces += allots.length;
      if (crossFeed) crossFeedGroups++;

      bump(byCategory, category, extras);
      for (const f of feeds) if (f !== 'Unknown') bump(byFeed, f, 0);
      // each repeat is attributed to whoever re-allotted it
      const repeatAllotters = new Map<string, number>();
      for (const r of repeats) {
        if (r.allottedBy !== 'Unknown')
          repeatAllotters.set(
            r.allottedBy,
            (repeatAllotters.get(r.allottedBy) || 0) + 1,
          );
      }
      for (const [name, n] of repeatAllotters) bump(byAllotter, name, n);

      titles.push({
        title: displayTitle,
        category,
        count: allots.length,
        crossFeed,
        distinctWriters: writers.size,
        first,
        repeats,
      });
    }

    titles.sort(
      (a, b) =>
        b.count - a.count ||
        (b.repeats[b.repeats.length - 1]?.date ?? '').localeCompare(
          a.repeats[a.repeats.length - 1]?.date ?? '',
        ),
    );

    return {
      asOf: now.toISOString(),
      duplicateTitles: titles.length,
      extraAllotments,
      affectedPieces,
      crossFeedGroups,
      byCategory: [...byCategory.values()].sort((a, b) => b.extras - a.extras),
      byFeed: [...byFeed.values()].sort((a, b) => b.groups - a.groups),
      topAllotters: [...byAllotter.values()].sort(
        (a, b) => b.extras - a.extras,
      ),
      titles: titles.slice(0, 100),
    };
  }
}
