import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { buildNameResolver } from '../production/name-resolver';
import { pct } from '../production/analytics';
import { todayIst, weekdayNameOf } from '../production/time';
import { SpSheetsSyncService } from './sheets-sync.service';
import { SpPiece } from './entities/sp-piece.entity';
import { SpRosterPerson } from './entities/sp-roster.entity';
import {
  OPEN_STAGES,
  STAGE_ORDER,
  StableStage,
  editDistance,
  isSubmittedStage,
  isVerifiedStage,
} from './normalize';
import {
  NamedCount,
  StableEditorStats,
  StableEventStats,
  StableFilterOptions,
  StableFilterParams,
  StableOverview,
  StableQuality,
  StableQueue,
  StableRosterEntry,
  StableSyncStatus,
  StableTypeMatrix,
  StableWriterStats,
  StageTotals,
} from './types';

/** The desk is one team across every event, so names resolve desk-wide. */
const DESK = 'Stable Desk';

type Resolve = (name: string) => string;

@Injectable()
export class StableProductionService implements OnModuleInit {
  private readonly logger = new Logger(StableProductionService.name);

  private lastSyncTime: Date | null = null;
  private syncing = false;
  private lastError: string | null = null;
  private skippedTabs: string[] = [];

  constructor(
    private readonly sheets: SpSheetsSyncService,
    @InjectRepository(SpPiece)
    private readonly pieceRepo: Repository<SpPiece>,
    @InjectRepository(SpRosterPerson)
    private readonly rosterRepo: Repository<SpRosterPerson>,
  ) {}

  onModuleInit() {
    this.syncData().catch((e) =>
      this.logger.error(`Initial Stable sync failed: ${e.message}`),
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
      const book = await this.sheets.fetchWorkbook();
      if (!book) return;
      // An empty read is far likelier a sharing or API problem than a desk
      // that deleted every event, so it never wipes the table.
      if (book.pieces.length > 0) {
        await this.replaceTable(
          this.pieceRepo,
          SpPiece,
          book.pieces,
          'pieces',
          force,
        );
      } else {
        this.logger.warn(
          'Stable sync read no event rows; keeping existing data',
        );
      }
      if (book.roster.length > 0) {
        await this.replaceTable(
          this.rosterRepo,
          SpRosterPerson,
          book.roster,
          'roster',
          force,
        );
      }
      this.skippedTabs = book.skippedTabs;
      this.lastSyncTime = new Date();
      this.logger.log(
        `Stable sync complete: ${book.pieces.length} pieces, ${book.roster.length} on the desk`,
      );
    } catch (e: any) {
      this.lastError = e.message;
      this.logger.error(`Stable sync failed: ${e.message}`);
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Hash-diff upsert + stale delete, as the other production syncs do. Keyed
   * by id with last-in winning, because one upsert batch must not target the
   * same id twice — Postgres rejects that outright.
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
      this.logger.log(`Stable ${label}: upserted ${rows.length} changed rows`);
    }

    const stale = [...hashes.keys()].filter((id) => !ids.has(id));
    for (let i = 0; i < stale.length; i += 500) {
      await repo.delete(stale.slice(i, i + 500));
    }
    if (stale.length)
      this.logger.log(`Stable ${label}: removed ${stale.length} stale rows`);
  }

  async getSyncStatus(): Promise<StableSyncStatus> {
    const events = await this.pieceRepo
      .createQueryBuilder('p')
      .select('COUNT(DISTINCT p.event)', 'n')
      .getRawOne<{ n: string }>();
    return {
      lastSyncTime: this.lastSyncTime?.toISOString() ?? null,
      rowCount: await this.pieceRepo.count(),
      eventCount: Number(events?.n ?? 0),
      rosterCount: await this.rosterRepo.count(),
      syncing: this.syncing,
      error: this.lastError,
      skippedTabs: this.skippedTabs,
    };
  }

  // ── Loading, names and filtering ──

  private async loadAll(): Promise<{
    pieces: SpPiece[];
    roster: SpRosterPerson[];
    resolve: Resolve;
  }> {
    const [pieces, roster] = await Promise.all([
      this.pieceRepo.find(),
      this.rosterRepo.find({ order: { sortOrder: 'ASC' } }),
    ]);
    return { pieces, roster, resolve: this.buildResolver(roster, pieces) };
  }

  /**
   * The shared resolver handles case and first-name stubs ("sayantani",
   * "Yusha"); on top of it, a single name within two edits of a rostered one
   * is that person misspelt ("Aradhaya" for "Aaradhya"). Only roster names are
   * fuzzy targets, so two unlisted people can never be fused.
   */
  private buildResolver(roster: SpRosterPerson[], pieces: SpPiece[]): Resolve {
    const base = buildNameResolver(
      roster.map((r) => ({ division: DESK, name: r.name })),
      pieces.map((p) => ({
        division: DESK,
        writer: p.writer,
        editor: p.editor,
        allottedBy: 'Unknown',
      })),
    );
    const rosterNames = roster.map((r) => r.name);
    const rosterLower = new Set(rosterNames.map((n) => n.toLowerCase()));
    const cache = new Map<string, string>();
    return (name: string) => {
      if (!name || name === 'Unknown') return name;
      const hit = cache.get(name);
      if (hit) return hit;
      let out = base(name, DESK);
      if (out === out.toLowerCase())
        out = out.replace(/\b\w/g, (c) => c.toUpperCase());
      if (
        !rosterLower.has(out.toLowerCase()) &&
        !/\s/.test(out) &&
        out.length >= 5
      ) {
        const close = rosterNames.filter((r) => {
          const first = r.toLowerCase().split(/\s+/)[0];
          return (
            first.length >= 5 && editDistance(out.toLowerCase(), first) <= 2
          );
        });
        if (close.length === 1) out = close[0];
      }
      cache.set(name, out);
      return out;
    };
  }

  private applyFilters(
    pieces: SpPiece[],
    f: StableFilterParams,
    resolve: Resolve,
  ): SpPiece[] {
    const inSet = (v: string, list?: string[]) =>
      !list?.length || list.includes(v);
    return pieces.filter(
      (p) =>
        inSet(p.event, f.events) &&
        inSet(p.sport, f.sports) &&
        inSet(resolve(p.writer), f.writers) &&
        inSet(resolve(p.editor), f.editors) &&
        inSet(p.stableType, f.stableTypes) &&
        inSet(p.stage, f.stages) &&
        inSet(p.pieceKind || 'Unspecified', f.kinds),
    );
  }

  private async filtered(f: StableFilterParams) {
    const all = await this.loadAll();
    return { ...all, rows: this.applyFilters(all.pieces, f, all.resolve) };
  }

  // ── Shared arithmetic ──

  private totals(rows: SpPiece[]): StageTotals {
    const count = (s: StableStage) => rows.filter((p) => p.stage === s).length;
    const trashed = count('Trashed');
    const verified = rows.filter((p) =>
      isVerifiedStage(p.stage as StableStage),
    ).length;
    return {
      allotted: rows.length,
      submitted: rows.filter((p) => isSubmittedStage(p.stage as StableStage))
        .length,
      verified,
      published: count('Published'),
      sentBack: count('Sent Back'),
      onHold: count('On Hold'),
      trashed,
      awaitingSubmission: count('Awaiting Submission'),
      awaitingEditorial: count('Awaiting Editorial'),
      inEditorial: count('In Editorial'),
      verifiedUnpublished: count('Verified'),
      open: rows.filter((p) => OPEN_STAGES.has(p.stage as StableStage)).length,
      completionRate: pct(verified, rows.length - trashed),
    };
  }

  private topCounts(values: string[], limit = 50): NamedCount[] {
    const m = new Map<string, number>();
    for (const v of values) {
      if (!v || v === 'Unknown') continue;
      m.set(v, (m.get(v) ?? 0) + 1);
    }
    return [...m.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  private byEventOrder<T extends { order: number; event: string }>(
    a: T,
    b: T,
  ): number {
    return a.order - b.order || a.event.localeCompare(b.event);
  }

  // ── Query surface ──

  async getFilterOptions(): Promise<StableFilterOptions> {
    const { pieces, resolve } = await this.loadAll();
    const events = new Map<
      string,
      { sport: string; order: number; pieces: number; open: number }
    >();
    const sets = {
      sports: new Set<string>(),
      writers: new Set<string>(),
      editors: new Set<string>(),
      stableTypes: new Set<string>(),
      stages: new Set<string>(),
      kinds: new Set<string>(),
    };
    for (const p of pieces) {
      if (!events.has(p.event))
        events.set(p.event, {
          sport: p.sport,
          order: p.eventOrder,
          pieces: 0,
          open: 0,
        });
      const e = events.get(p.event)!;
      e.pieces++;
      if (OPEN_STAGES.has(p.stage as StableStage)) e.open++;
      sets.sports.add(p.sport);
      if (p.writer !== 'Unknown') sets.writers.add(resolve(p.writer));
      if (p.editor !== 'Unknown') sets.editors.add(resolve(p.editor));
      sets.stableTypes.add(p.stableType);
      sets.stages.add(p.stage);
      sets.kinds.add(p.pieceKind || 'Unspecified');
    }
    const sorted = (s: Set<string>) => [...s].sort();
    return {
      events: [...events.entries()]
        .map(([event, v]) => ({ event, ...v }))
        .sort((a, b) => this.byEventOrder(a, b)),
      sports: sorted(sets.sports),
      writers: sorted(sets.writers),
      editors: sorted(sets.editors),
      stableTypes: sorted(sets.stableTypes),
      stages: STAGE_ORDER.filter((s) => sets.stages.has(s)),
      kinds: sorted(sets.kinds),
    };
  }

  async getOverview(f: StableFilterParams): Promise<StableOverview> {
    const { rows, resolve } = await this.filtered(f);
    const t = this.totals(rows);
    return {
      ...t,
      events: new Set(rows.map((p) => p.event)).size,
      writers: new Set(
        rows
          .filter((p) => p.writer !== 'Unknown')
          .map((p) => resolve(p.writer)),
      ).size,
      editors: new Set(
        rows
          .filter((p) => p.editor !== 'Unknown')
          .map((p) => resolve(p.editor)),
      ).size,
      newCount: rows.filter((p) => p.pieceKind === 'New').length,
      updateCount: rows.filter((p) => p.pieceKind === 'Update').length,
      stages: STAGE_ORDER.map((stage) => ({
        stage,
        count: rows.filter((p) => p.stage === stage).length,
      })).filter((s) => s.count > 0),
    };
  }

  async getEvents(f: StableFilterParams): Promise<StableEventStats[]> {
    const { rows, resolve } = await this.filtered(f);
    const groups = new Map<string, SpPiece[]>();
    for (const p of rows) {
      if (!groups.has(p.event)) groups.set(p.event, []);
      groups.get(p.event)!.push(p);
    }
    return [...groups.entries()]
      .map(([event, rs]) => ({
        event,
        sport: rs[0].sport,
        order: rs[0].eventOrder,
        ...this.totals(rs),
        newCount: rs.filter((p) => p.pieceKind === 'New').length,
        updateCount: rs.filter((p) => p.pieceKind === 'Update').length,
        writers: this.topCounts(rs.map((p) => resolve(p.writer))),
        editors: this.topCounts(rs.map((p) => resolve(p.editor))),
        stableTypes: this.topCounts(rs.map((p) => p.stableType)),
      }))
      .sort((a, b) => this.byEventOrder(a, b));
  }

  async getWriters(f: StableFilterParams): Promise<StableWriterStats[]> {
    const { rows, roster, resolve } = await this.filtered(f);
    const rosterBy = new Map(roster.map((r) => [r.name.toLowerCase(), r]));
    const groups = new Map<string, SpPiece[]>();
    for (const p of rows) {
      const name = resolve(p.writer);
      if (name === 'Unknown') continue;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(p);
    }
    return [...groups.entries()]
      .map(([writer, rs]) => {
        const r = rosterBy.get(writer.toLowerCase());
        return {
          writer,
          onRoster: !!r,
          dailyTarget: r?.dailyTarget ?? null,
          shift: r?.shift ?? '',
          ...this.totals(rs),
          events: this.topCounts(rs.map((p) => p.event)),
        };
      })
      .sort((a, b) => b.allotted - a.allotted);
  }

  async getEditors(f: StableFilterParams): Promise<StableEditorStats[]> {
    const { rows, roster, resolve } = await this.filtered(f);
    const rosterNames = new Set(roster.map((r) => r.name.toLowerCase()));
    const groups = new Map<string, SpPiece[]>();
    for (const p of rows) {
      const name = resolve(p.editor);
      if (name === 'Unknown') continue;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(p);
    }
    return [...groups.entries()]
      .map(([editor, rs]) => {
        const t = this.totals(rs);
        return {
          editor,
          onRoster: rosterNames.has(editor.toLowerCase()),
          handled: rs.length,
          verified: t.verified,
          published: t.published,
          sentBack: t.sentBack,
          inEditorial: t.inEditorial,
          onHold: t.onHold,
          trashed: t.trashed,
          events: this.topCounts(rs.map((p) => p.event)),
        };
      })
      .sort((a, b) => b.handled - a.handled);
  }

  async getStableTypes(f: StableFilterParams): Promise<StableTypeMatrix> {
    const { rows } = await this.filtered(f);
    const typeCounts = this.topCounts(rows.map((p) => p.stableType));
    const types = typeCounts.map((t) => t.name);

    const byEvent = new Map<
      string,
      {
        sport: string;
        order: number;
        total: number;
        cells: Record<string, number>;
      }
    >();
    for (const p of rows) {
      if (!byEvent.has(p.event)) {
        byEvent.set(p.event, {
          sport: p.sport,
          order: p.eventOrder,
          total: 0,
          cells: {},
        });
      }
      const e = byEvent.get(p.event)!;
      e.total++;
      e.cells[p.stableType] = (e.cells[p.stableType] ?? 0) + 1;
    }

    return {
      types,
      rows: [...byEvent.entries()]
        .map(([event, v]) => ({ event, ...v }))
        .sort((a, b) => this.byEventOrder(a, b)),
      totals: types.map((stableType) => {
        const rs = rows.filter((p) => p.stableType === stableType);
        const t = this.totals(rs);
        return {
          stableType,
          count: rs.length,
          verified: t.verified,
          published: t.published,
          open: t.open,
        };
      }),
    };
  }

  /** Everything still waiting on someone, oldest event tab last. */
  async getQueue(f: StableFilterParams): Promise<StableQueue> {
    const { rows, resolve } = await this.filtered(f);
    const open = rows.filter((p) => OPEN_STAGES.has(p.stage as StableStage));
    const stageRank = new Map(STAGE_ORDER.map((s, i) => [s, i]));
    const items = open
      .sort(
        (a, b) =>
          a.eventOrder - b.eventOrder ||
          (stageRank.get(a.stage as StableStage) ?? 0) -
            (stageRank.get(b.stage as StableStage) ?? 0) ||
          a.sheetRow - b.sheetRow,
      )
      .map((p) => ({
        id: p.id,
        event: p.event,
        sport: p.sport,
        sheetRow: p.sheetRow,
        player: p.player,
        title: p.title,
        stableType: p.stableType,
        pieceKind: p.pieceKind,
        writer: resolve(p.writer),
        editor: resolve(p.editor),
        stage: p.stage,
        editingStatus: p.editingStatus,
        stagingLink: p.stagingLink,
        researchDoc: p.researchDoc,
        editorComments: p.editorComments,
      }));
    return {
      stages: STAGE_ORDER.filter((s) => OPEN_STAGES.has(s)).map((stage) => ({
        stage,
        count: open.filter((p) => p.stage === stage).length,
      })),
      items: items.slice(0, 1000),
      total: items.length,
    };
  }

  async getRoster(f: StableFilterParams): Promise<StableRosterEntry[]> {
    const { rows, roster, resolve } = await this.filtered(f);
    const today = weekdayNameOf(todayIst(new Date())).toLowerCase();
    return roster.map((r) => {
      const mine = rows.filter(
        (p) => resolve(p.writer) === r.name || resolve(p.editor) === r.name,
      );
      return {
        name: r.name,
        position: r.position,
        roleGroup: r.roleGroup,
        dailyTarget: r.dailyTarget,
        bandwidthNote: r.bandwidthNote,
        timings: r.timings,
        shift: r.shift,
        weekoff: r.weekoff,
        offToday: !!r.weekoff && r.weekoff.toLowerCase().includes(today),
        open: mine.filter((p) => OPEN_STAGES.has(p.stage as StableStage))
          .length,
        total: mine.length,
      };
    });
  }

  async getQuality(f: StableFilterParams): Promise<StableQuality> {
    const { rows, roster, resolve } = await this.filtered(f);

    const issues = [
      {
        issue: 'No headline in the sheet',
        count: rows.filter((p) => !p.hasHeadline).length,
        detail: 'Title column blank — shown here as "Player — Type"',
      },
      {
        issue: 'Verified but not marked scheduled',
        count: rows.filter((p) => p.stage === 'Verified').length,
        detail:
          'Cleared by the editor with no Published URL, scheduling time or "schd" note',
      },
      {
        issue: 'Submitted with no editor',
        count: rows.filter(
          (p) => p.stage === 'Awaiting Editorial' && p.editor === 'Unknown',
        ).length,
        detail:
          'A staging link or submission doc is in, but nobody has picked it up',
      },
      {
        issue: 'No stable type',
        count: rows.filter((p) => p.stableType === 'Unspecified').length,
        detail: 'Left out of the stable-type mix',
      },
      {
        issue: 'New / Update not marked',
        count: rows.filter((p) => !p.pieceKind).length,
        detail: 'The New/Updation column is blank or holds something else',
      },
      {
        issue: 'No writer',
        count: rows.filter((p) => p.writer === 'Unknown').length,
        detail: 'Writer Name blank, or a link pasted into it',
      },
    ].filter((i) => i.count > 0);

    const spellings = new Map<string, Map<string, number>>();
    for (const p of rows) {
      for (const raw of [p.writer, p.editor]) {
        if (raw === 'Unknown') continue;
        const name = resolve(raw);
        if (!spellings.has(name)) spellings.set(name, new Map());
        const m = spellings.get(name)!;
        m.set(raw, (m.get(raw) ?? 0) + 1);
      }
    }
    const nameMerges = [...spellings.entries()]
      .filter(([, m]) => m.size > 1)
      .map(([name, m]) => ({
        name,
        spellings: [...m.entries()]
          .map(([spelling, pieces]) => ({ spelling, pieces }))
          .sort((a, b) => b.pieces - a.pieces),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const rosterNames = new Set(roster.map((r) => r.name.toLowerCase()));
    const unrosteredMap = new Map<
      string,
      { role: Set<string>; pieces: number }
    >();
    for (const p of rows) {
      for (const [raw, role] of [
        [p.writer, 'Writer'],
        [p.editor, 'Editor'],
      ] as const) {
        if (raw === 'Unknown' || raw === 'Division Editor') continue;
        const name = resolve(raw);
        if (rosterNames.has(name.toLowerCase())) continue;
        if (!unrosteredMap.has(name))
          unrosteredMap.set(name, { role: new Set(), pieces: 0 });
        const u = unrosteredMap.get(name)!;
        u.role.add(role);
        u.pieces++;
      }
    }
    const unrostered = roster.length
      ? [...unrosteredMap.entries()]
          .map(([name, u]) => ({
            name,
            role: [...u.role].join(' / '),
            pieces: u.pieces,
          }))
          .sort((a, b) => b.pieces - a.pieces)
      : [];

    // The same player and type is expected again in a later event as an
    // Update, so only two shapes are flagged: a repeat inside one event, and
    // the same piece written as New more than once anywhere.
    const dupMap = new Map<string, SpPiece[]>();
    for (const p of rows) {
      if (
        p.stage === 'Trashed' ||
        p.stableType === 'Unspecified' ||
        p.stableType === 'Other'
      )
        continue;
      const key = `${p.player.toLowerCase().replace(/\s+/g, ' ').trim()}|${p.stableType}`;
      if (!dupMap.has(key)) dupMap.set(key, []);
      dupMap.get(key)!.push(p);
    }
    const duplicates = [...dupMap.values()]
      .map((rs) => {
        const perEvent = new Map<string, number>();
        for (const p of rs)
          perEvent.set(p.event, (perEvent.get(p.event) ?? 0) + 1);
        const sameEvent = [...perEvent.values()].some((n) => n > 1);
        const newCount = rs.filter((p) => p.pieceKind === 'New').length;
        return { rs, sameEvent, flagged: sameEvent || newCount > 1 };
      })
      .filter((d) => d.flagged)
      .map(({ rs, sameEvent }) => ({
        player: rs[0].player,
        stableType: rs[0].stableType,
        count: rs.length,
        sameEvent,
        events: [...new Set(rs.map((p) => p.event))],
        writers: [
          ...new Set(
            rs.map((p) => resolve(p.writer)).filter((w) => w !== 'Unknown'),
          ),
        ],
      }))
      .sort(
        (a, b) =>
          Number(b.sameEvent) - Number(a.sameEvent) ||
          b.count - a.count ||
          a.player.localeCompare(b.player),
      )
      .slice(0, 200);

    return { issues, nameMerges, unrostered, duplicates };
  }
}
