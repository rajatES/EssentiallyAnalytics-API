import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProductionAnalyticsService } from '../production/production-analytics.service';
import { RosterPerson, StageApi } from '../production/production-piece';
import { CfSheetsSyncService } from './sheets-sync.service';
import { CfPiece } from './entities/cf-piece.entity';
import { ResourceDirectoryService } from '../resources/resource-directory.service';
import * as stages from './stages';
import { SyncStatus } from './types';

/**
 * Critical Flow's two-pass lifecycle: a first editorial pass that may send the
 * piece back, then a second one. Handed to the shared analytics so every
 * surface agrees on what "verified" and "sent back" mean.
 */
const CF_STAGES: StageApi<CfPiece> = {
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
export class CriticalFlowService
  extends ProductionAnalyticsService<CfPiece>
  implements OnModuleInit
{
  protected readonly logger = new Logger(CriticalFlowService.name);
  protected readonly st = CF_STAGES;

  private lastSyncTime: Date | null = null;
  private syncing = false;
  private lastError: string | null = null;

  constructor(
    private readonly sheets: CfSheetsSyncService,
    @InjectRepository(CfPiece)
    private readonly pieceRepo: Repository<CfPiece>,
    private readonly directory: ResourceDirectoryService,
  ) {
    super();
  }

  protected async loadPieces(): Promise<CfPiece[]> {
    return this.pieceRepo.find();
  }

  /** People from the shared Dynamic Schedule list, placed under CF's divisions. */
  protected async loadRoster(): Promise<RosterPerson[]> {
    const rows: { division: string }[] = await this.pieceRepo
      .createQueryBuilder('p')
      .select('DISTINCT p.division', 'division')
      .getRawMany();
    return this.directory.rosterFor(rows.map((r) => r.division));
  }

  async onModuleInit() {
    this.syncData().catch((e) =>
      this.logger.error(`Initial Critical Flow sync failed: ${e.message}`),
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
        const existing = await this.pieceRepo.find({ select: ['id', 'rawHash'] });
        const hashes = new Map(existing.map((r) => [r.id, r.rawHash]));

        // Keyed by id (last wins): the aggregate sheet can carry two rows that
        // resolve to the same piece id, and one upsert batch must not target
        // the same id twice — Postgres rejects that outright.
        const toUpsert = new Map<string, CfPiece>();
        const incoming = new Set<string>();

        for (const p of pieces) {
          incoming.add(p.id);
          if (!force && hashes.get(p.id) === p.rawHash) continue;
          const e = new CfPiece();
          Object.assign(e, p);
          toUpsert.set(p.id, e);
        }

        if (toUpsert.size) {
          const rows = [...toUpsert.values()];
          for (let i = 0; i < rows.length; i += 500) {
            await this.pieceRepo.upsert(rows.slice(i, i + 500), ['id']);
          }
          this.logger.log(`CF pieces: upserted ${rows.length} changed rows`);
        }

        const stale = [...hashes.keys()].filter((id) => !incoming.has(id));
        for (let i = 0; i < stale.length; i += 500) {
          await this.pieceRepo.delete(stale.slice(i, i + 500));
        }
        if (stale.length) this.logger.log(`CF pieces: removed ${stale.length} stale rows`);
      }

      this.lastSyncTime = new Date();
      this.logger.log(`CF sync complete: ${await this.pieceRepo.count()} pieces`);
    } catch (e: any) {
      this.lastError = e.message;
      this.logger.error(`CF sync failed: ${e.message}`);
    } finally {
      this.syncing = false;
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
}
