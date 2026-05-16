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
import * as crypto from 'crypto';
import { SheetsSyncService } from './sheets-sync.service';
import { MsnSourceRow } from './entities/msn-source.entity';
import { MsnAllotmentRow } from './entities/msn-allotment.entity';
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
  ContentMixEntry,
  HeatmapCell,
  LeakageResult,
  FilterOptions,
  SyncStatus,
  DailyBreakdownEntry,
  PersonAverage,
  DailyBreakdownResult,
} from './types';

@Injectable()
export class MsnProductionService {
  private readonly logger = new Logger(MsnProductionService.name);

  private lastSyncTime: Date | null = null;
  private syncing = false;
  private lastError: string | null = null;

  constructor(
    private readonly sheetsSyncService: SheetsSyncService,
    @InjectRepository(MsnSourceRow)
    private readonly sourceRepo: Repository<MsnSourceRow>,
    @InjectRepository(MsnAllotmentRow)
    private readonly allotmentRepo: Repository<MsnAllotmentRow>,
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
      const [sourceRows, allotmentRows] = await Promise.all([
        this.sheetsSyncService.fetchSourceSheet(),
        this.sheetsSyncService.fetchAllotmentSheet(),
      ]);

      // Upsert source rows — use rowId as natural key
      if (sourceRows.length > 0) {
        const existingHashes = new Map<string, string>();
        const existing = await this.sourceRepo.find({
          select: ['rowId', 'rawHash'],
        });
        for (const row of existing) existingHashes.set(row.rowId, row.rawHash);

        const toUpsert: MsnSourceRow[] = [];
        const incomingIds = new Set<string>();

        for (const row of sourceRows) {
          incomingIds.add(row.rowId);
          if (existingHashes.get(row.rowId) === row.rawHash) continue;

          const entity = new MsnSourceRow();
          entity.rowId = row.rowId;
          entity.date = row.date;
          entity.brand = row.brand;
          entity.contentType = row.contentType;
          entity.feed = row.feed;
          entity.writer = row.writer;
          entity.editor = row.editor;
          entity.status = row.status;
          entity.numberOfSlides = row.numberOfSlides;
          entity.publishTimestamp = row.publishTimestamp;
          entity.title = row.title;
          entity.rawHash = row.rawHash;
          toUpsert.push(entity);
        }

        if (toUpsert.length > 0) {
          await this.sourceRepo.upsert(toUpsert, ['rowId']);
          this.logger.log(`Source: upserted ${toUpsert.length} changed rows`);
        }

        // Remove rows no longer in sheet
        const staleIds = [...existingHashes.keys()].filter(
          (id) => !incomingIds.has(id),
        );
        if (staleIds.length > 0) {
          await this.sourceRepo.delete(staleIds);
          this.logger.log(`Source: removed ${staleIds.length} stale rows`);
        }
      }

      // Upsert allotment rows — deterministic ID from row content
      if (allotmentRows.length > 0) {
        const existingHashes = new Map<string, string>();
        const existing = await this.allotmentRepo.find({
          select: ['id', 'rawHash'],
        });
        for (const row of existing) existingHashes.set(row.id, row.rawHash);

        const toUpsert: MsnAllotmentRow[] = [];
        const incomingIds = new Set<string>();

        for (let i = 0; i < allotmentRows.length; i++) {
          const row = allotmentRows[i];
          // Deterministic ID: hash of row position + key fields to handle true duplicates
          const idSource = `${row.date}|${row.brand}|${row.feed}|${row.writer}|${row.title}|${row.allottedBy}|${i}`;
          const id = crypto.createHash('md5').update(idSource).digest('hex');

          incomingIds.add(id);
          if (existingHashes.get(id) === row.rawHash) continue;

          const entity = new MsnAllotmentRow();
          entity.id = id;
          entity.allottedBy = row.allottedBy;
          entity.date = row.date;
          entity.brand = row.brand;
          entity.feed = row.feed;
          entity.writer = row.writer;
          entity.contentType = row.contentType;
          entity.status = row.status;
          entity.slides = row.slides;
          entity.title = row.title;
          entity.rawHash = row.rawHash;
          toUpsert.push(entity);
        }

        if (toUpsert.length > 0) {
          // Batch upserts to avoid param limit
          for (let i = 0; i < toUpsert.length; i += 500) {
            await this.allotmentRepo.upsert(toUpsert.slice(i, i + 500), ['id']);
          }
          this.logger.log(
            `Allotment: upserted ${toUpsert.length} changed rows`,
          );
        }

        // Remove stale rows
        const staleIds = [...existingHashes.keys()].filter(
          (id) => !incomingIds.has(id),
        );
        if (staleIds.length > 0) {
          for (let i = 0; i < staleIds.length; i += 500) {
            await this.allotmentRepo.delete(staleIds.slice(i, i + 500));
          }
          this.logger.log(`Allotment: removed ${staleIds.length} stale rows`);
        }
      }

      const [srcCount, allCount] = await Promise.all([
        this.sourceRepo.count(),
        this.allotmentRepo.count(),
      ]);

      this.lastSyncTime = new Date();
      this.logger.log(
        `Sync complete: ${srcCount} source rows, ${allCount} allotment rows in DB`,
      );
    } catch (e: any) {
      this.lastError = e.message;
      this.logger.error(`Sync failed: ${e.message}`);
    } finally {
      this.syncing = false;
    }
  }

  async getSyncStatus(): Promise<SyncStatus> {
    const [sourceRowCount, allotmentRowCount] = await Promise.all([
      this.sourceRepo.count(),
      this.allotmentRepo.count(),
    ]);
    return {
      lastSyncTime: this.lastSyncTime?.toISOString() ?? null,
      sourceRowCount,
      allotmentRowCount,
      syncing: this.syncing,
      error: this.lastError,
    };
  }

  // ── Filtering helpers ──

  private buildSourceWhere(params: MsnFilterParams): any {
    const where: any = {};
    if (params.startDate && params.endDate) {
      where.date = Between(params.startDate, params.endDate);
    } else if (params.startDate) {
      where.date = MoreThanOrEqual(params.startDate);
    } else if (params.endDate) {
      where.date = LessThanOrEqual(params.endDate);
    }
    if (params.brands?.length) where.brand = In(params.brands);
    if (params.feeds?.length) where.feed = In(params.feeds);
    if (params.writers?.length) where.writer = In(params.writers);
    if (params.editors?.length) where.editor = In(params.editors);
    if (params.contentTypes?.length)
      where.contentType = In(params.contentTypes);
    if (params.statuses?.length) where.status = In(params.statuses);
    return where;
  }

  private buildAllotmentWhere(params: MsnFilterParams): any {
    const where: any = {};
    if (params.startDate && params.endDate) {
      where.date = Between(params.startDate, params.endDate);
    } else if (params.startDate) {
      where.date = MoreThanOrEqual(params.startDate);
    } else if (params.endDate) {
      where.date = LessThanOrEqual(params.endDate);
    }
    if (params.brands?.length) where.brand = In(params.brands);
    if (params.feeds?.length) where.feed = In(params.feeds);
    if (params.writers?.length) where.writer = In(params.writers);
    if (params.contentTypes?.length)
      where.contentType = In(params.contentTypes);
    if (params.statuses?.length) where.status = In(params.statuses);
    if (params.allotters?.length) where.allottedBy = In(params.allotters);
    return where;
  }

  private async filterSource(params: MsnFilterParams): Promise<MsnSourceRow[]> {
    return this.sourceRepo.find({ where: this.buildSourceWhere(params) });
  }

  private async filterAllotment(
    params: MsnFilterParams,
  ): Promise<MsnAllotmentRow[]> {
    return this.allotmentRepo.find({ where: this.buildAllotmentWhere(params) });
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

  // ── Public query methods ──

  async getFilterOptions(): Promise<FilterOptions> {
    const [sourceRows, allotmentRows] = await Promise.all([
      this.sourceRepo.find(),
      this.allotmentRepo.find(),
    ]);

    const brands = new Set<string>();
    const feeds = new Set<string>();
    const writers = new Set<string>();
    const editors = new Set<string>();
    const contentTypes = new Set<string>();
    const statuses = new Set<string>();
    const allotters = new Set<string>();
    let minDate = '';
    let maxDate = '';

    for (const r of sourceRows) {
      if (r.brand && r.brand !== 'Unknown') brands.add(r.brand);
      if (r.feed && r.feed !== 'Unknown') feeds.add(r.feed);
      if (r.writer && r.writer !== 'Unknown') writers.add(r.writer);
      if (r.editor && r.editor !== 'Unknown') editors.add(r.editor);
      if (r.contentType && r.contentType !== 'Unknown')
        contentTypes.add(r.contentType);
      if (r.status && r.status !== 'Unknown') statuses.add(r.status);
      if (r.date) {
        const d = typeof r.date === 'string' ? r.date : r.date;
        if (!minDate || d < minDate) minDate = d;
        if (!maxDate || d > maxDate) maxDate = d;
      }
    }

    for (const r of allotmentRows) {
      if (r.brand && r.brand !== 'Unknown') brands.add(r.brand);
      if (r.feed && r.feed !== 'Unknown') feeds.add(r.feed);
      if (r.writer && r.writer !== 'Unknown') writers.add(r.writer);
      if (r.contentType && r.contentType !== 'Unknown')
        contentTypes.add(r.contentType);
      if (r.status && r.status !== 'Unknown') statuses.add(r.status);
      if (r.allottedBy && r.allottedBy !== 'Unknown')
        allotters.add(r.allottedBy);
      if (r.date) {
        const d = typeof r.date === 'string' ? r.date : r.date;
        if (!minDate || d < minDate) minDate = d;
        if (!maxDate || d > maxDate) maxDate = d;
      }
    }

    return {
      brands: [...brands].sort(),
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
    const [source, allotment] = await Promise.all([
      this.filterSource(params),
      this.filterAllotment(params),
    ]);
    const prevParams = this.getPreviousPeriodParams(params);
    const [prevSource, prevAllotment] = await Promise.all([
      this.filterSource(prevParams),
      this.filterAllotment(prevParams),
    ]);

    const cur = this.computeKpis(source, allotment);
    const prev = this.computeKpis(prevSource, prevAllotment);

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

  private computeKpis(
    source: MsnSourceRow[],
    allotment: MsnAllotmentRow[],
  ): Omit<KpiOverview, 'deltas'> {
    const totalProduced = source.length;
    const totalAllotted = allotment.length;
    const published = source.filter(
      (r) => r.status === 'Published' || r.status === 'Published (PR)',
    ).length;
    const scheduled = source.filter(
      (r) => r.status === 'Scheduled' || r.status === 'Scheduled (PR)',
    ).length;
    const publishRate =
      totalAllotted > 0
        ? Math.round((published / totalAllotted) * 1000) / 10
        : 0;

    const leadTimes: number[] = [];
    for (const r of source) {
      if (r.publishTimestamp && r.date) {
        const diff =
          new Date(r.publishTimestamp).getTime() - new Date(r.date).getTime();
        if (diff >= 0 && diff < 30 * 24 * 3600 * 1000) {
          leadTimes.push(diff / 3600000);
        }
      }
    }
    leadTimes.sort((a, b) => a - b);
    const avgLeadTimeHours =
      leadTimes.length > 0
        ? Math.round(leadTimes[Math.floor(leadTimes.length / 2)] * 10) / 10
        : 0;

    const writers = new Set(
      source.map((r) => r.writer).filter((w) => w !== 'Unknown'),
    );
    const dates = new Set(source.map((r) => r.date).filter(Boolean));
    const numDays = Math.max(dates.size, 1);
    const numWriters = Math.max(writers.size, 1);
    const piecesPerWriterPerDay =
      Math.round((totalProduced / numWriters / numDays) * 100) / 100;

    const dropOff = source.filter(
      (r) => r.status === 'Sent Back' || r.status === 'Trashed',
    ).length;
    const dropOffRate =
      totalProduced > 0 ? Math.round((dropOff / totalProduced) * 1000) / 10 : 0;

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
    const [source, allotment] = await Promise.all([
      this.filterSource(params),
      this.filterAllotment(params),
    ]);

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
      if (granularity === 'month') {
        return dayStr.substring(0, 7);
      }
      return dayStr;
    };

    const buckets = new Map<string, TimeseriesBucket>();

    for (const r of source) {
      const key = bucketKey(r.date);
      if (key === 'unknown') continue;
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
      const b = buckets.get(key)!;
      if (r.contentType === 'Article') b.article++;
      else if (r.contentType === 'Slideshow') b.slideshow++;
      else if (r.contentType === 'SS Automation') b.ssAutomation++;
      if (r.status === 'Published' || r.status === 'Published (PR)')
        b.published++;
    }

    for (const r of allotment) {
      const key = bucketKey(r.date);
      if (key === 'unknown') continue;
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
      buckets.get(key)!.allotted++;
    }

    return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  async getFunnel(params: MsnFilterParams): Promise<FunnelStage[]> {
    const [allotment, source] = await Promise.all([
      this.filterAllotment(params),
      this.filterSource(params),
    ]);

    const allotted = allotment.length;
    const submitted = allotment.filter((r) =>
      ['Submitted', 'Published', 'Scheduled', 'Picked'].includes(r.status),
    ).length;
    const scheduled = source.filter((r) =>
      ['Scheduled', 'Scheduled (PR)', 'Published', 'Published (PR)'].includes(
        r.status,
      ),
    ).length;
    const published = source.filter(
      (r) => r.status === 'Published' || r.status === 'Published (PR)',
    ).length;

    const stages = [
      { stage: 'Allotted', count: allotted },
      { stage: 'Submitted', count: submitted },
      { stage: 'Scheduled', count: scheduled },
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
  ): Promise<{ source: StatusMixEntry[]; allotment: StatusMixEntry[] }> {
    const [source, allotment] = await Promise.all([
      this.filterSource(params),
      this.filterAllotment(params),
    ]);

    const countBy = (rows: { status: string }[]): StatusMixEntry[] => {
      const map = new Map<string, number>();
      for (const r of rows) {
        map.set(r.status, (map.get(r.status) || 0) + 1);
      }
      const total = rows.length;
      return [...map.entries()]
        .map(([status, count]) => ({
          status,
          count,
          percentage: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.count - a.count);
    };

    return {
      source: countBy(source),
      allotment: countBy(allotment),
    };
  }

  async getFeedStats(params: MsnFilterParams): Promise<FeedStats[]> {
    const [source, allotment] = await Promise.all([
      this.filterSource(params),
      this.filterAllotment(params),
    ]);

    const feedMap = new Map<string, FeedStats>();

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

    for (const r of allotment) getOrCreate(r.feed).allotted++;

    const leadTimes = new Map<string, number[]>();

    for (const r of source) {
      const f = getOrCreate(r.feed);
      f.produced++;
      if (r.status === 'Published' || r.status === 'Published (PR)')
        f.published++;
      if (r.contentType === 'Article') f.articles++;
      else if (r.contentType === 'Slideshow') f.slideshows++;
      else if (r.contentType === 'SS Automation') f.ssAutomation++;

      if (r.publishTimestamp && r.date) {
        const diff =
          (new Date(r.publishTimestamp).getTime() -
            new Date(r.date).getTime()) /
          3600000;
        if (diff >= 0 && diff < 720) {
          if (!leadTimes.has(r.feed)) leadTimes.set(r.feed, []);
          leadTimes.get(r.feed)!.push(diff);
        }
      }
    }

    for (const f of feedMap.values()) {
      f.publishRate =
        f.allotted > 0 ? Math.round((f.published / f.allotted) * 1000) / 10 : 0;
      const lt = leadTimes.get(f.feed);
      if (lt?.length) {
        lt.sort((a, b) => a - b);
        f.avgLeadTimeHours =
          Math.round(lt[Math.floor(lt.length / 2)] * 10) / 10;
      }
    }

    return [...feedMap.values()].sort((a, b) => b.produced - a.produced);
  }

  async getWriterStats(params: MsnFilterParams): Promise<WriterStats[]> {
    const [source, allotment] = await Promise.all([
      this.filterSource(params),
      this.filterAllotment(params),
    ]);

    const wMap = new Map<string, WriterStats>();

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

    for (const r of allotment) {
      if (r.writer !== 'Unknown') {
        const w = getOrCreate(r.writer);
        w.allotted++;
        if (['Submitted', 'Published', 'Scheduled'].includes(r.status))
          w.submitted++;
      }
    }

    const leadTimes = new Map<string, number[]>();

    for (const r of source) {
      if (r.writer === 'Unknown') continue;
      const w = getOrCreate(r.writer);
      w.total++;
      if (r.status === 'Published' || r.status === 'Published (PR)')
        w.published++;
      if (r.contentType === 'Article') w.articles++;
      else if (
        r.contentType === 'Slideshow' ||
        r.contentType === 'SS Automation'
      )
        w.slideshows++;

      if (r.publishTimestamp && r.date) {
        const diff =
          (new Date(r.publishTimestamp).getTime() -
            new Date(r.date).getTime()) /
          3600000;
        if (diff >= 0 && diff < 720) {
          if (!leadTimes.has(r.writer)) leadTimes.set(r.writer, []);
          leadTimes.get(r.writer)!.push(diff);
        }
      }
    }

    for (const w of wMap.values()) {
      w.publishRate =
        w.allotted > 0 ? Math.round((w.published / w.allotted) * 1000) / 10 : 0;
      const sentBack = source.filter(
        (r) =>
          r.writer === w.writer &&
          (r.status === 'Sent Back' || r.status === 'Trashed'),
      ).length;
      w.sentBackRate =
        w.total > 0 ? Math.round((sentBack / w.total) * 1000) / 10 : 0;
      const lt = leadTimes.get(w.writer);
      if (lt?.length) {
        lt.sort((a, b) => a - b);
        w.avgLeadTimeHours =
          Math.round(lt[Math.floor(lt.length / 2)] * 10) / 10;
      }
    }

    return [...wMap.values()].sort((a, b) => b.total - a.total);
  }

  async getEditorStats(params: MsnFilterParams): Promise<EditorStats[]> {
    const source = await this.filterSource(params);

    const eMap = new Map<
      string,
      {
        count: number;
        leadTimes: number[];
        sentBack: number;
        types: Set<string>;
      }
    >();

    for (const r of source) {
      if (!r.editor || r.editor === 'Unknown') continue;
      if (!eMap.has(r.editor)) {
        eMap.set(r.editor, {
          count: 0,
          leadTimes: [],
          sentBack: 0,
          types: new Set(),
        });
      }
      const e = eMap.get(r.editor)!;
      e.count++;
      e.types.add(r.contentType);
      if (r.status === 'Sent Back') e.sentBack++;
      if (r.publishTimestamp && r.date) {
        const diff =
          (new Date(r.publishTimestamp).getTime() -
            new Date(r.date).getTime()) /
          3600000;
        if (diff >= 0 && diff < 720) e.leadTimes.push(diff);
      }
    }

    return [...eMap.entries()]
      .map(([editor, data]) => {
        data.leadTimes.sort((a, b) => a - b);
        return {
          editor,
          articlesEdited: data.count,
          avgTurnaroundHours:
            data.leadTimes.length > 0
              ? Math.round(
                  data.leadTimes[Math.floor(data.leadTimes.length / 2)] * 10,
                ) / 10
              : 0,
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
    const allotment = await this.filterAllotment(params);

    const aMap = new Map<
      string,
      {
        volume: number;
        published: number;
        feedCounts: Map<string, number>;
        writerCounts: Map<string, number>;
      }
    >();

    for (const r of allotment) {
      if (r.allottedBy === 'Unknown') continue;
      if (!aMap.has(r.allottedBy)) {
        aMap.set(r.allottedBy, {
          volume: 0,
          published: 0,
          feedCounts: new Map(),
          writerCounts: new Map(),
        });
      }
      const a = aMap.get(r.allottedBy)!;
      a.volume++;
      a.feedCounts.set(r.feed, (a.feedCounts.get(r.feed) || 0) + 1);
      a.writerCounts.set(r.writer, (a.writerCounts.get(r.writer) || 0) + 1);
      if (r.status === 'Published' || r.status === 'Scheduled') a.published++;
    }

    return [...aMap.entries()]
      .map(([allottedBy, data]) => {
        const topFeed =
          [...data.feedCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ||
          '';
        const topWriter =
          [...data.writerCounts.entries()].sort(
            (a, b) => b[1] - a[1],
          )[0]?.[0] || '';
        return {
          allottedBy,
          volume: data.volume,
          publishedRate:
            data.volume > 0
              ? Math.round((data.published / data.volume) * 1000) / 10
              : 0,
          avgLeadTimeHours: 0,
          topFeed,
          topWriter,
        };
      })
      .sort((a, b) => b.volume - a.volume);
  }

  async getContentMix(
    params: MsnFilterParams,
    granularity: string = 'week',
  ): Promise<ContentMixEntry[]> {
    const source = await this.filterSource(params);

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

    for (const r of source) {
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
    const source = await this.filterSource(params);

    if (type === 'feed-writer') {
      const cells = new Map<string, number>();
      for (const r of source) {
        const key = `${r.feed}||${r.writer}`;
        cells.set(key, (cells.get(key) || 0) + 1);
      }
      return [...cells.entries()].map(([key, value]) => {
        const [row, col] = key.split('||');
        return { row, col, value };
      });
    }

    // Writer × Day of Week heatmap
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const cells = new Map<string, number>();
    for (const r of source) {
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

  async getWriterDailyBreakdown(
    params: MsnFilterParams,
  ): Promise<DailyBreakdownResult> {
    const source = await this.filterSource(params);

    const dayMap = new Map<string, DailyBreakdownEntry>();

    for (const r of source) {
      if (!r.date || r.writer === 'Unknown') continue;
      const key = `${r.writer}||${r.date}`;
      if (!dayMap.has(key)) {
        dayMap.set(key, {
          name: r.writer,
          date: r.date,
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
        entry.slides += r.numberOfSlides ?? 0;
        entry.total++;
      }
    }

    const daily = [...dayMap.values()].sort(
      (a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name),
    );

    const personMap = new Map<
      string,
      {
        slides: number;
        slideshows: number;
        articles: number;
        days: Set<string>;
      }
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

    const totalWriters = Math.max(personalAverages.length, 1);
    const teamAverage = {
      avgSlides:
        Math.round(
          (personalAverages.reduce((s, p) => s + p.avgSlides, 0) /
            totalWriters) *
            10,
        ) / 10,
      avgSlideshows:
        Math.round(
          (personalAverages.reduce((s, p) => s + p.avgSlideshows, 0) /
            totalWriters) *
            10,
        ) / 10,
      avgArticles:
        Math.round(
          (personalAverages.reduce((s, p) => s + p.avgArticles, 0) /
            totalWriters) *
            10,
        ) / 10,
      avgTotal:
        Math.round(
          (personalAverages.reduce((s, p) => s + p.avgTotal, 0) /
            totalWriters) *
            10,
        ) / 10,
    };

    return { daily, personalAverages, teamAverage };
  }

  async getEditorDailyBreakdown(
    params: MsnFilterParams,
  ): Promise<DailyBreakdownResult> {
    const source = await this.filterSource(params);

    const dayMap = new Map<string, DailyBreakdownEntry>();

    for (const r of source) {
      if (!r.date || !r.editor || r.editor === 'Unknown') continue;
      const key = `${r.editor}||${r.date}`;
      if (!dayMap.has(key)) {
        dayMap.set(key, {
          name: r.editor,
          date: r.date,
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
        entry.slides += r.numberOfSlides ?? 0;
        entry.total++;
      }
    }

    const daily = [...dayMap.values()].sort(
      (a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name),
    );

    const personMap = new Map<
      string,
      {
        slides: number;
        slideshows: number;
        articles: number;
        days: Set<string>;
      }
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

    const totalEditors = Math.max(personalAverages.length, 1);
    const teamAverage = {
      avgSlides:
        Math.round(
          (personalAverages.reduce((s, p) => s + p.avgSlides, 0) /
            totalEditors) *
            10,
        ) / 10,
      avgSlideshows:
        Math.round(
          (personalAverages.reduce((s, p) => s + p.avgSlideshows, 0) /
            totalEditors) *
            10,
        ) / 10,
      avgArticles:
        Math.round(
          (personalAverages.reduce((s, p) => s + p.avgArticles, 0) /
            totalEditors) *
            10,
        ) / 10,
      avgTotal:
        Math.round(
          (personalAverages.reduce((s, p) => s + p.avgTotal, 0) /
            totalEditors) *
            10,
        ) / 10,
    };

    return { daily, personalAverages, teamAverage };
  }

  async getLeakage(params: MsnFilterParams): Promise<LeakageResult> {
    const [source, allotment] = await Promise.all([
      this.filterSource(params),
      this.filterAllotment(params),
    ]);

    const publishedSource = source.filter(
      (r) => r.status === 'Published' || r.status === 'Published (PR)',
    );

    const allotmentTitles = new Set(
      allotment.map((r) => r.title.toLowerCase().trim()).filter(Boolean),
    );
    const sourceTitles = new Set(
      publishedSource.map((r) => r.title.toLowerCase().trim()).filter(Boolean),
    );

    const publishedWithoutAllotment = publishedSource
      .filter(
        (r) => r.title && !allotmentTitles.has(r.title.toLowerCase().trim()),
      )
      .slice(0, 100)
      .map((r) => ({
        title: r.title,
        date: r.date || '',
        writer: r.writer,
        feed: r.feed,
      }));

    const allottedWithoutPublish = allotment
      .filter((r) => r.title && !sourceTitles.has(r.title.toLowerCase().trim()))
      .slice(0, 100)
      .map((r) => ({
        title: r.title,
        date: r.date || '',
        writer: r.writer,
        feed: r.feed,
      }));

    return {
      publishedWithoutAllotment,
      allottedWithoutPublish,
      publishedWithoutAllotmentCount: publishedSource.filter(
        (r) => r.title && !allotmentTitles.has(r.title.toLowerCase().trim()),
      ).length,
      allottedWithoutPublishCount: allotment.filter(
        (r) => r.title && !sourceTitles.has(r.title.toLowerCase().trim()),
      ).length,
    };
  }
}
