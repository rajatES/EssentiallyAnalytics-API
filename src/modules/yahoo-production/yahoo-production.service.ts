import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProductionAnalyticsService } from '../production/production-analytics.service';
import { RosterPerson, StageApi } from '../production/production-piece';
import { activeDayCount, perDay, round } from '../production/analytics';
import { YpSheetsSyncService } from './sheets-sync.service';
import { YpPiece } from './entities/yp-piece.entity';
import { YpDivisionQuota } from './entities/yp-division-quota.entity';
import { ResourceDirectoryService } from '../resources/resource-directory.service';
import * as stages from './stages';
import { SyncStatus, YpFilterParams, YpQuotaAttainment } from './types';

/**
 * Yahoo's single-pass lifecycle. Handed to the shared analytics so this page
 * and Critical Flow agree on what every stage means, while differing exactly
 * where the pipelines genuinely differ — Yahoo has no send-back loop.
 */
const YP_STAGES: StageApi<YpPiece> = {
  reachedEditorial: (p) => stages.reachedEditorial(p),
  isSubmitted: (p) => stages.isSubmitted(p),
  isVerified: (p) => stages.isVerified(p),
  isSentBack: (p) => stages.isSentBack(p),
  isOpenSendBack: (p) => stages.isOpenSendBack(p),
  isPublished: (p) => stages.isPublished(p),
  isKilled: (p) => stages.isKilled(p),
  isOnHold: (p) => stages.isOnHold(p),
  pendingStage: (p, now) => stages.pendingStage(p, now),
  pendingAnchor: (p, stage) => stages.pendingAnchor(p, stage as stages.PendingStage),
};

@Injectable()
export class YahooProductionService
  extends ProductionAnalyticsService<YpPiece>
  implements OnModuleInit
{
  protected readonly logger = new Logger(YahooProductionService.name);
  protected readonly st = YP_STAGES;

  private lastSyncTime: Date | null = null;
  private syncing = false;
  private lastError: string | null = null;

  constructor(
    private readonly sheets: YpSheetsSyncService,
    @InjectRepository(YpPiece)
    private readonly pieceRepo: Repository<YpPiece>,
    @InjectRepository(YpDivisionQuota)
    private readonly quotaRepo: Repository<YpDivisionQuota>,
    private readonly directory: ResourceDirectoryService,
  ) {
    super();
  }

  protected async loadPieces(): Promise<YpPiece[]> {
    return this.pieceRepo.find();
  }

  /**
   * The same people as Critical Flow — one shared Dynamic Schedule list —
   * placed under Yahoo's own division labels ("CFB", "Tennis"), which is what
   * this pipeline's name resolver and roster board are keyed on.
   */
  protected async loadRoster(): Promise<RosterPerson[]> {
    const rows: { division: string }[] = await this.pieceRepo
      .createQueryBuilder('p')
      .select('DISTINCT p.division', 'division')
      .getRawMany();
    return this.directory.rosterFor(rows.map((r) => r.division));
  }

  async onModuleInit() {
    this.syncData().catch((e) =>
      this.logger.error(`Initial Yahoo sync failed: ${e.message}`),
    );
  }

  @Cron('*/10 * * * *')
  async scheduledSync() {
    await this.syncData();
  }

  // ── Sync ──

  async syncData(force = false): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.lastError = null;
    try {
      const pieces = await this.sheets.fetchPieces();
      if (pieces.length > 0) {
        await this.replaceTable(this.pieceRepo, YpPiece, pieces, 'pieces', force);
      }

      const quotas = await this.sheets.fetchQuotas();
      if (quotas.length > 0) {
        await this.replaceTable(
          this.quotaRepo,
          YpDivisionQuota,
          quotas,
          'division quotas',
          force,
        );
      }

      this.lastSyncTime = new Date();
      this.logger.log(
        `Yahoo sync complete: ${await this.pieceRepo.count()} pieces, ` +
          `${await this.quotaRepo.count()} quotas`,
      );
    } catch (e: any) {
      this.lastError = e.message;
      this.logger.error(`Yahoo sync failed: ${e.message}`);
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Hash-diff upsert + stale delete: rows whose hash is unchanged are skipped,
   * rows no longer in the source are removed. Keyed by id with last-in
   * winning, because one upsert batch must not target the same id twice —
   * Postgres rejects that outright.
   */
  private async replaceTable<T extends { id: string; rawHash: string }>(
    repo: Repository<any>,
    Entity: new () => T,
    incoming: T[],
    label: string,
    force: boolean,
  ): Promise<void> {
    const existing: { id: string; rawHash: string }[] = await repo.find({
      select: ['id', 'rawHash'],
    });
    const hashes = new Map(existing.map((r) => [r.id, r.rawHash]));
    const toUpsert = new Map<string, T>();
    const ids = new Set<string>();

    for (const row of incoming) {
      ids.add(row.id);
      if (!force && hashes.get(row.id) === row.rawHash) continue;
      const e = new Entity();
      Object.assign(e, row);
      toUpsert.set(row.id, e);
    }

    if (toUpsert.size) {
      const rows = [...toUpsert.values()];
      for (let i = 0; i < rows.length; i += 500) {
        await repo.upsert(rows.slice(i, i + 500), ['id']);
      }
      this.logger.log(`Yahoo ${label}: upserted ${rows.length} changed rows`);
    }

    const stale = [...hashes.keys()].filter((id) => !ids.has(id));
    for (let i = 0; i < stale.length; i += 500) {
      await repo.delete(stale.slice(i, i + 500));
    }
    if (stale.length) {
      this.logger.log(`Yahoo ${label}: removed ${stale.length} stale rows`);
    }
  }

  async getSyncStatus(): Promise<SyncStatus> {
    return {
      lastSyncTime: this.lastSyncTime?.toISOString() ?? null,
      rowCount: await this.pieceRepo.count(),
      rosterCount: await this.directory.count(),
      syncing: this.syncing,
      error: this.lastError,
    };
  }

  // ── Yahoo-only surface ──

  /**
   * Output against the daily quota the managers set per division.
   *
   * Measured per *active* day — days the division published something — rather
   * than per calendar day, so a weekend or a quiet holiday does not read as a
   * missed target. Divisions with no quota row still appear, with a null
   * target, because "nobody set a quota for this" is itself worth seeing.
   */
  async getQuotaAttainment(params: YpFilterParams): Promise<YpQuotaAttainment[]> {
    const [rows, quotas] = await Promise.all([
      this.filter(params),
      this.quotaRepo.find(),
    ]);

    // division → the quota row covering it.
    const byDivision = new Map<string, YpDivisionQuota>();
    for (const q of quotas) {
      for (const d of q.divisions?.length ? q.divisions : [q.division]) {
        if (!byDivision.has(d)) byDivision.set(d, q);
      }
    }

    const groups = new Map<string, { quota: YpDivisionQuota | null; rows: YpPiece[]; divisions: Set<string> }>();
    for (const p of rows) {
      const q = byDivision.get(p.division) ?? null;
      const key = q ? q.id : `ungrouped:${p.division}`;
      if (!groups.has(key)) {
        groups.set(key, { quota: q, rows: [], divisions: new Set() });
      }
      const g = groups.get(key)!;
      g.rows.push(p);
      g.divisions.add(p.division);
    }

    return [...groups.values()]
      .map(({ quota, rows: rs, divisions }) => {
        const publishedRows = rs.filter((p) => this.isPublished(p));
        const days = activeDayCount(publishedRows, (p) => p.publishedDate, {
          fallback: (p) => p.date,
          startDate: params.startDate,
          endDate: params.endDate,
        });
        const rate = perDay(publishedRows.length, days);
        const target = quota?.quota ?? null;
        return {
          quotaGroup: quota?.division ?? [...divisions].join(', '),
          divisions: [...divisions].sort(),
          quota: target,
          window: quota?.window ?? '',
          poc: quota?.poc ?? '',
          allotted: rs.length,
          published: publishedRows.length,
          activeDays: days,
          perDay: rate,
          attainment: target && target > 0 ? round((rate / target) * 100) : null,
        };
      })
      .sort((a, b) => b.published - a.published);
  }
}
