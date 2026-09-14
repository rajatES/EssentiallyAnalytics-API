import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CfSheetsSyncService } from './sheets-sync.service';
import { CfPiece } from './entities/cf-piece.entity';
import { CfRosterPerson } from './entities/cf-roster-person.entity';
import { CfSchedulePerson } from './entities/cf-schedule-person.entity';
import { CfLeave } from './entities/cf-leave.entity';
import { CfDivisionQuota } from './entities/cf-division-quota.entity';
import { ScheduleSyncService } from './schedule-sync.service';
import * as stages from './stages';
import {
  ArticleTypeEntry,
  CfFilterParams,
  DivisionStats,
  EditorStats,
  FilterOptions,
  FunnelStage,
  InsightsResult,
  KpiDelta,
  KpiOverview,
  PendingItem,
  PendingResult,
  RosterResult,
  SendBackResult,
  SyncStatus,
  TatResult,
  TatStat,
  TimeseriesBucket,
  WriterStats,
  AllotterStats,
  YahooSplitResult,
} from './types';

/** Canonicalises a person's name within a division. */
type NameResolver = (name: string, division: string) => string;

/** Age bands (hours) used for the pending board. */
const AGE_BANDS: [string, number, number][] = [
  ['< 4h', 0, 4],
  ['4–12h', 4, 12],
  ['12–24h', 12, 24],
  ['1–3d', 24, 72],
  ['3–7d', 72, 168],
  ['> 7d', 168, Infinity],
];
const TAT_BANDS: [string, number, number][] = [
  ['< 1h', 0, 1],
  ['1–2h', 1, 2],
  ['2–4h', 2, 4],
  ['4–8h', 4, 8],
  ['8–24h', 8, 24],
  ['1–3d', 24, 72],
  ['> 3d', 72, Infinity],
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function hoursBetween(from: Date | null, to: Date | null, capHours = 24 * 60): number | null {
  if (!from || !to) return null;
  const diff = (new Date(to).getTime() - new Date(from).getTime()) / 3600000;
  if (diff < 0 || diff > capHours) return null;
  return diff;
}

function round(n: number, dp = 1): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

/**
 * Median, or null when there is nothing to average. Used wherever a 0 would be
 * read as "instant" rather than "not measurable" — several source columns are
 * only sporadically filled in, and a fake 0 there is worse than a blank.
 */
function medianOrNull(values: number[]): number | null {
  return values.length ? median(values) : null;
}

function percentileOrNull(values: number[], p: number): number | null {
  return values.length ? percentile(values, p) : null;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
}

function pct(part: number, whole: number): number {
  return whole > 0 ? round((part / whole) * 100) : 0;
}

function band(value: number, bands: [string, number, number][]): string {
  for (const [label, lo, hi] of bands) if (value >= lo && value < hi) return label;
  return bands[bands.length - 1][0];
}

@Injectable()
export class CriticalFlowService implements OnModuleInit {
  private readonly logger = new Logger(CriticalFlowService.name);

  private lastSyncTime: Date | null = null;
  private syncing = false;
  private lastError: string | null = null;

  constructor(
    private readonly sheets: CfSheetsSyncService,
    @InjectRepository(CfPiece)
    private readonly pieceRepo: Repository<CfPiece>,
    @InjectRepository(CfRosterPerson)
    private readonly rosterRepo: Repository<CfRosterPerson>,
    @InjectRepository(CfSchedulePerson)
    private readonly schedRepo: Repository<CfSchedulePerson>,
    @InjectRepository(CfLeave)
    private readonly leaveRepo: Repository<CfLeave>,
    @InjectRepository(CfDivisionQuota)
    private readonly quotaRepo: Repository<CfDivisionQuota>,
    private readonly schedule: ScheduleSyncService,
  ) {}

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

      const roster = await this.sheets.fetchRoster();
      if (roster.length > 0) {
        const existing = await this.rosterRepo.find({ select: ['id', 'rawHash'] });
        const hashes = new Map(existing.map((r) => [r.id, r.rawHash]));
        const toUpsert = new Map<string, CfRosterPerson>();
        const incoming = new Set<string>();
        for (const r of roster) {
          incoming.add(r.id);
          if (!force && hashes.get(r.id) === r.rawHash) continue;
          const e = new CfRosterPerson();
          Object.assign(e, r);
          toUpsert.set(r.id, e);
        }
        if (toUpsert.size) {
          const rows = [...toUpsert.values()];
          for (let i = 0; i < rows.length; i += 500) {
            await this.rosterRepo.upsert(rows.slice(i, i + 500), ['id']);
          }
          this.logger.log(`CF roster: upserted ${rows.length} changed rows`);
        }
        const stale = [...hashes.keys()].filter((id) => !incoming.has(id));
        if (stale.length) await this.rosterRepo.delete(stale);
      }

      // The managers' schedule workbook — people, leave, per-shift quotas.
      // A failed or unconfigured read leaves the previous data untouched.
      const sched = await this.schedule.fetch();
      if (sched) {
        await this.replaceTable(this.schedRepo, CfSchedulePerson, sched.people, 'schedule people');
        await this.replaceTable(this.leaveRepo, CfLeave, sched.leaves, 'leave records');
        await this.replaceTable(this.quotaRepo, CfDivisionQuota, sched.quotas, 'division quotas');
      }

      this.lastSyncTime = new Date();
      this.logger.log(
        `CF sync complete: ${await this.pieceRepo.count()} pieces, ` +
          `${await this.rosterRepo.count()} roster rows, ` +
          `${await this.schedRepo.count()} schedule people`,
      );
    } catch (e: any) {
      this.lastError = e.message;
      this.logger.error(`CF sync failed: ${e.message}`);
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Hash-diff upsert + stale delete for the small schedule tables: rows whose
   * hash is unchanged are skipped, rows no longer in the source are removed.
   */
  private async replaceTable<T extends { id: string; rawHash: string }>(
    repo: Repository<any>,
    Entity: new () => T,
    incoming: T[],
    label: string,
  ): Promise<void> {
    const existing: { id: string; rawHash: string }[] = await repo.find({
      select: ['id', 'rawHash'],
    });
    const hashes = new Map(existing.map((r) => [r.id, r.rawHash]));
    const toUpsert = new Map<string, T>();
    const ids = new Set<string>();
    for (const row of incoming) {
      ids.add(row.id);
      if (hashes.get(row.id) === row.rawHash) continue;
      const e = new Entity();
      Object.assign(e, row);
      toUpsert.set(row.id, e);
    }
    if (toUpsert.size) {
      const rows = [...toUpsert.values()];
      for (let i = 0; i < rows.length; i += 500) {
        await repo.upsert(rows.slice(i, i + 500), ['id']);
      }
      this.logger.log(`CF ${label}: upserted ${rows.length} changed rows`);
    }
    const stale = [...hashes.keys()].filter((id) => !ids.has(id));
    if (stale.length) {
      for (let i = 0; i < stale.length; i += 500) {
        await repo.delete(stale.slice(i, i + 500));
      }
      this.logger.log(`CF ${label}: removed ${stale.length} stale rows`);
    }
  }

  async getSyncStatus(): Promise<SyncStatus> {
    return {
      lastSyncTime: this.lastSyncTime?.toISOString() ?? null,
      rowCount: await this.pieceRepo.count(),
      rosterCount: await this.rosterRepo.count(),
      syncing: this.syncing,
      error: this.lastError,
    };
  }

  // ── Stage predicates ──
  //
  // A division may skip filling in "Submitted At" entirely and still run the
  // piece through editorial, so submission is inferred from any later evidence
  // rather than trusted as a lone column.

  private reachedEditorial(p: CfPiece): boolean {
    return stages.reachedEditorial(p);
  }

  private isSubmitted(p: CfPiece): boolean {
    return stages.isSubmitted(p);
  }

  private isVerified(p: CfPiece): boolean {
    return stages.isVerified(p);
  }

  /** Went back to the writer at least once. */
  private isSentBack(p: CfPiece): boolean {
    return stages.isSentBack(p);
  }

  /** Sent back and not yet cleared by a later pass. */
  private isOpenSendBack(p: CfPiece): boolean {
    return stages.isOpenSendBack(p);
  }

  private isPublished(p: CfPiece): boolean {
    return stages.isPublished(p);
  }

  private isKilled(p: CfPiece): boolean {
    return stages.isKilled(p);
  }

  private isOnHold(p: CfPiece): boolean {
    return stages.isOnHold(p);
  }

  /** Effective turnaround: the sheet's own TAT, else allotment → publication. */
  private tat(p: CfPiece): number | null {
    if (p.tatHours != null && p.tatHours > 0 && p.tatHours < 24 * 60) return p.tatHours;
    const end = p.liveAt || p.editorAt2 || p.editorAt;
    return hoursBetween(p.allottedAt, end);
  }

  /**
   * Every division records allotment in a "Date (Automated)" column that holds
   * a date with no time, so the stamp lands on midnight. Measuring
   * allotment → submission against that midnight invents ~20h of "writing
   * time" that never happened, so the leg is only measurable where the source
   * actually captured a clock time.
   */
  private hasAllotmentTime(p: CfPiece): boolean {
    if (!p.allottedAt) return false;
    const d = new Date(p.allottedAt);
    return d.getHours() !== 0 || d.getMinutes() !== 0 || d.getSeconds() !== 0;
  }

  /** Hours from allotment to submission, or null when allotment has no clock time. */
  private writeHours(p: CfPiece): number | null {
    if (!this.hasAllotmentTime(p)) return null;
    return hoursBetween(p.allottedAt, p.submittedAt);
  }

  /**
   * Which queue a piece is sitting in, or null when it is finished, killed or
   * so old that calling it "pending" would be misleading.
   */
  private pendingStage(p: CfPiece, now: Date): string | null {
    return stages.pendingStage(p, now);
  }

  private pendingAnchor(p: CfPiece, stage: string): Date | null {
    return stages.pendingAnchor(p, stage as stages.PendingStage);
  }

  private pendingWith(p: CfPiece, stage: string): string {
    if (stage === 'Awaiting Submission' || stage === 'Sent Back') return p.writer;
    return p.editor !== 'Unknown' ? p.editor : 'Unassigned';
  }

  private toPendingItem(p: CfPiece, stage: string, now: Date): PendingItem {
    const since = this.pendingAnchor(p, stage);
    return {
      id: p.id,
      division: p.division,
      stage,
      pendingWith: this.pendingWith(p, stage),
      title: p.title,
      stagingLink: p.stagingLink,
      waitingSince: since ? new Date(since).toISOString() : null,
      ageingHours: since
        ? round((now.getTime() - new Date(since).getTime()) / 3600000)
        : 0,
    };
  }

  // ── Filtering ──

  private async load(): Promise<CfPiece[]> {
    return this.pieceRepo.find();
  }

  private async filter(params: CfFilterParams): Promise<CfPiece[]> {
    const rows = await this.load();
    const inSet = (v: string, list?: string[]) => !list?.length || list.includes(v);

    return rows.filter((p) => {
      if (params.startDate && (!p.date || p.date < params.startDate)) return false;
      if (params.endDate && (!p.date || p.date > params.endDate)) return false;
      if (!inSet(p.division, params.divisions)) return false;
      if (!inSet(p.writer, params.writers)) return false;
      if (!inSet(p.editor, params.editors)) return false;
      if (!inSet(p.articleType, params.articleTypes)) return false;
      if (!inSet(p.editorialStatus, params.statuses)) return false;
      if (!inSet(p.allottedBy, params.allotters)) return false;
      if (params.yahoo === 'yahoo' && p.yahoo !== true) return false;
      if (params.yahoo === 'non-yahoo' && p.yahoo !== false) return false;
      return true;
    });
  }

  /** Same-length window immediately before the requested one, for deltas. */
  private previousPeriod(params: CfFilterParams): CfFilterParams {
    if (!params.startDate || !params.endDate) return { ...params };
    const start = new Date(params.startDate);
    const end = new Date(params.endDate);
    const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
    const prevEnd = new Date(start);
    prevEnd.setDate(prevEnd.getDate() - 1);
    const prevStart = new Date(prevEnd);
    prevStart.setDate(prevStart.getDate() - days + 1);
    return {
      ...params,
      startDate: prevStart.toISOString().slice(0, 10),
      endDate: prevEnd.toISOString().slice(0, 10),
    };
  }

  private delta(cur: number, prev: number): KpiDelta {
    return {
      value: round(cur - prev),
      pct: prev > 0 ? round(((cur - prev) / prev) * 100) : null,
    };
  }

  // ── Name canonicalisation ──
  //
  // The source sheets record the same person as "Dhruv", "Dhruv Singh" and
  // occasionally a misspelling, which fragments every per-person total. The
  // resolver below collapses those to one identity and MUST be applied by every
  // per-person aggregation — a table that skips it will silently disagree with
  // the headline numbers.

  async nameResolver(): Promise<NameResolver> {
    const roster = await this.rosterRepo.find();
    const pieces = await this.load();

    // Resolution is scoped to a division. Two divisions routinely staff people
    // who share a first name — NASCAR's "Dhruv" is not NFL's "Dhruv Singh" —
    // so merging across divisions would fuse two real people into one.
    const divisions = new Set<string>([
      ...roster.map((r) => r.division),
      ...pieces.map((p) => p.division),
    ]);
    const perDivision = new Map<string, (n: string) => string>();
    for (const division of divisions) {
      perDivision.set(
        division,
        this.buildDivisionResolver(
          roster.filter((r) => r.division === division).map((r) => r.name).filter(Boolean),
          pieces.filter((p) => p.division === division),
        ),
      );
    }

    // Names differing only in capitalisation ("aadesh" / "Aadesh") are the same
    // person even across divisions — unlike a shared first name, an exact match
    // ignoring case carries no ambiguity. Folded globally, after the
    // division-scoped pass, so one editor working two divisions appears once.
    const rosterSpelling = new Map<string, string>();
    for (const r of roster) {
      const low = r.name.toLowerCase();
      if (!rosterSpelling.has(low)) rosterSpelling.set(low, r.name);
    }
    const caseFreq = new Map<string, number>();
    const seenResolved = new Set<string>();
    for (const p of pieces) {
      const fn = perDivision.get(p.division);
      if (!fn) continue;
      for (const raw of [p.writer, p.editor, p.editor2, p.allottedBy]) {
        if (!raw || raw === 'Unknown') continue;
        const resolved = fn(raw);
        seenResolved.add(resolved);
        caseFreq.set(resolved, (caseFreq.get(resolved) ?? 0) + 1);
      }
    }
    const canonicalCase = new Map<string, string>();
    for (const n of seenResolved) {
      const low = n.toLowerCase();
      const roster = rosterSpelling.get(low);
      if (roster) {
        canonicalCase.set(low, roster);
        continue;
      }
      const cur = canonicalCase.get(low);
      if (!cur) {
        canonicalCase.set(low, n);
        continue;
      }
      const fn = caseFreq.get(n) ?? 0;
      const fc = caseFreq.get(cur) ?? 0;
      const preferN =
        fn > fc || (fn === fc && /^[A-Z]/.test(n) && !/^[A-Z]/.test(cur));
      if (preferN) canonicalCase.set(low, n);
    }

    return (name: string, division: string): string => {
      const fn = perDivision.get(division);
      const resolved = fn ? fn(name) : name;
      return canonicalCase.get(resolved.toLowerCase()) ?? resolved;
    };
  }

  private buildDivisionResolver(
    rosterNames: string[],
    pieces: CfPiece[],
  ): (n: string) => string {
    // Raw name → how often it appears, used to pick the winning spelling when
    // the only difference is capitalisation ("aadesh" vs "Aadesh").
    const freq = new Map<string, number>();
    const bump = (n: string) => {
      if (!n || n === 'Unknown') return;
      freq.set(n, (freq.get(n) ?? 0) + 1);
    };
    for (const p of pieces) {
      bump(p.writer);
      bump(p.editor);
      bump(p.editor2);
      bump(p.allottedBy);
    }
    const dataNames = [...freq.keys()];

    // "Archana.R" and "Archana" are the same person, so an initial glued on
    // with a dot tokenises the same way a space would.
    const tokensOf = (n: string): string[] =>
      n.toLowerCase().split(/[\s.]+/).filter(Boolean);

    const rosterByLower = new Map<string, string>();
    for (const n of rosterNames) {
      const low = n.toLowerCase();
      if (!rosterByLower.has(low)) rosterByLower.set(low, n);
    }

    // Roster people recorded under a single name ("Himanga", "Archana"): that
    // spelling is the official one and wins over any longer data variant.
    const rosterSingle = new Map<string, string>();
    for (const n of rosterNames) {
      const t = tokensOf(n);
      if (t.length === 1 && !rosterSingle.has(t[0])) rosterSingle.set(t[0], n);
    }

    // The sheets mix a person's full name with an abbreviation: a bare first
    // name ("Khosalu"), or a first name plus an initial ("Utsav S",
    // "Archana.R"). Neither form identifies a person on its own, so both count
    // as stubs that expand to the one full name sharing their first token.
    // Where two people share a first name ("Utsav Sinha" and "Utsav Jain") no
    // expansion is safe and the identities stay separate.
    const isStub = (t: string[]): boolean =>
      t.length < 2 || t.some((tok) => tok.length < 2);

    const fullByFirst = new Map<string, Map<string, string>>();
    const addFull = (n: string, preferred: boolean) => {
      const t = tokensOf(n);
      if (isStub(t)) return; // stubs do not define an identity
      const key = t.join(' ');
      if (!fullByFirst.has(t[0])) fullByFirst.set(t[0], new Map());
      const m = fullByFirst.get(t[0])!;
      if (preferred || !m.has(key)) m.set(key, n);
    };
    for (const n of rosterNames) addFull(n, true);
    for (const n of dataNames) addFull(n, false);

    // Case-only variants collapse onto the roster spelling, else the commonest.
    // A capitalised spelling beats an all-lowercase one at equal frequency, so
    // the merged identity still displays like a name.
    const displayByKey = new Map<string, string>();
    const better = (a: string, b: string): boolean => {
      const fa = freq.get(a) ?? 0;
      const fb = freq.get(b) ?? 0;
      if (fa !== fb) return fa > fb;
      const ca = /^[A-Z]/.test(a);
      const cb = /^[A-Z]/.test(b);
      return ca && !cb;
    };
    for (const n of dataNames) {
      const low = n.toLowerCase();
      const roster = rosterByLower.get(low);
      if (roster) {
        displayByKey.set(low, roster);
        continue;
      }
      const cur = displayByKey.get(low);
      if (!cur || better(n, cur)) displayByKey.set(low, n);
    }

    const cache = new Map<string, string>();
    return (name: string): string => {
      if (!name || name === 'Unknown' || name === 'Unassigned') return name;
      const hit = cache.get(name);
      if (hit) return hit;

      const low = name.toLowerCase();
      const t = tokensOf(name);
      let out: string;

      if (rosterByLower.has(low)) {
        out = rosterByLower.get(low)!;
      } else if (isStub(t)) {
        // The roster spelling wins when the person is listed under a single
        // name, so "Suryakant" and "Suryakant Das" both land on "Suryakant"
        // rather than pulling in opposite directions.
        const fulls = fullByFirst.get(t[0]);
        out =
          rosterSingle.get(t[0]) ??
          (fulls && fulls.size === 1
            ? [...fulls.values()][0]           // "Khosalu" → "Khosalu Puro"
            : displayByKey.get(low) ?? name);
      } else {
        const fulls = fullByFirst.get(t[0]);
        // A rostered single name plus at most one longer variant means the
        // longer one is a data embellishment ("Suryakant Das" → "Suryakant").
        if (rosterSingle.has(t[0]) && (!fulls || fulls.size === 1)) {
          out = rosterSingle.get(t[0])!;
        } else if (fulls && fulls.size === 1) {
          out = [...fulls.values()][0];
        } else {
          out = displayByKey.get(low) ?? name;
        }
      }

      cache.set(name, out);
      return out;
    };
  }

  // ── Query surface ──

  async getFilterOptions(): Promise<FilterOptions> {
    const rows = await this.load();
    const resolve = await this.nameResolver();
    const s = {
      divisions: new Set<string>(),
      writers: new Set<string>(),
      editors: new Set<string>(),
      articleTypes: new Set<string>(),
      statuses: new Set<string>(),
      allotters: new Set<string>(),
      sbReasons: new Set<string>(),
    };
    let min = '';
    let max = '';
    for (const p of rows) {
      if (p.division !== 'Unknown') s.divisions.add(p.division);
      if (p.writer !== 'Unknown') s.writers.add(resolve(p.writer, p.division));
      if (p.editor !== 'Unknown') s.editors.add(resolve(p.editor, p.division));
      if (p.articleType !== 'Unknown') s.articleTypes.add(p.articleType);
      if (p.editorialStatus) s.statuses.add(p.editorialStatus);
      if (p.allottedBy !== 'Unknown') s.allotters.add(resolve(p.allottedBy, p.division));
      if (p.sbReason) s.sbReasons.add(p.sbReason);
      if (p.date) {
        if (!min || p.date < min) min = p.date;
        if (!max || p.date > max) max = p.date;
      }
    }
    const sorted = (x: Set<string>) => [...x].sort();
    return {
      divisions: sorted(s.divisions),
      writers: sorted(s.writers),
      editors: sorted(s.editors),
      articleTypes: sorted(s.articleTypes),
      statuses: sorted(s.statuses),
      allotters: sorted(s.allotters),
      sbReasons: sorted(s.sbReasons),
      dateRange: { min, max },
    };
  }

  async getOverview(params: CfFilterParams): Promise<KpiOverview> {
    const resolve = await this.nameResolver();
    const rows = await this.filter(params);
    const cur = this.computeKpis(rows, resolve);

    const KEYS = [
      'allotted', 'submitted', 'verified', 'published', 'publishRate',
      'submissionRate', 'sendBackRate', 'medianTatHours', 'yahooShare',
      'pendingCount', 'perWriterPerDay',
    ] as const;

    // With no date range there is no preceding window to compare against, and
    // reporting 0 would read as "unchanged" rather than "not comparable".
    const comparable = !!(params.startDate && params.endDate);
    const deltas: Record<string, KpiDelta> = {};
    if (!comparable) {
      for (const key of KEYS) deltas[key] = { value: 0, pct: null };
      return { ...cur, deltasAvailable: false, deltas };
    }

    const prev = this.computeKpis(await this.filter(this.previousPeriod(params)), resolve);
    for (const key of KEYS) {
      deltas[key] = this.delta(cur[key] as number, prev[key] as number);
    }
    return { ...cur, deltasAvailable: true, deltas };
  }

  private computeKpis(
    rows: CfPiece[],
    resolve: NameResolver,
  ): Omit<KpiOverview, 'deltas' | 'deltasAvailable'> {
    const now = new Date();
    const allotted = rows.length;
    const submitted = rows.filter((p) => this.isSubmitted(p)).length;
    const verified = rows.filter((p) => this.isVerified(p)).length;
    const published = rows.filter((p) => this.isPublished(p)).length;
    const reachedEd = rows.filter((p) => this.reachedEditorial(p));
    const sentBack = rows.filter((p) => this.isSentBack(p)).length;

    const tats = rows.map((p) => this.tat(p)).filter((n): n is number => n != null);
    const yahooCount = rows.filter((p) => p.yahoo === true).length;
    const yahooKnown = rows.filter((p) => p.yahoo !== null).length;

    const pendingCount = rows.filter((p) => this.pendingStage(p, now) !== null).length;

    const writers = new Set(
      rows.filter((p) => p.writer !== 'Unknown').map((p) => resolve(p.writer, p.division)),
    );
    const editors = new Set(
      rows.filter((p) => p.editor !== 'Unknown').map((p) => resolve(p.editor, p.division)),
    );
    const days = new Set(rows.map((p) => p.date).filter(Boolean)).size || 1;

    return {
      allotted,
      submitted,
      verified,
      published,
      publishRate: pct(published, allotted),
      submissionRate: pct(submitted, allotted),
      sendBackRate: pct(sentBack, reachedEd.length),
      medianTatHours: median(tats),
      p90TatHours: percentile(tats, 90),
      yahooCount,
      yahooShare: pct(yahooCount, yahooKnown),
      pendingCount,
      activeWriters: writers.size,
      activeEditors: editors.size,
      perWriterPerDay: round(submitted / Math.max(writers.size, 1) / days, 2),
    };
  }

  async getTimeseries(
    params: CfFilterParams,
    granularity = 'day',
  ): Promise<TimeseriesBucket[]> {
    const rows = await this.filter(params);
    const key = (d: string): string => {
      if (granularity === 'month') return d.slice(0, 7);
      if (granularity === 'week') {
        const dt = new Date(d);
        dt.setDate(dt.getDate() - dt.getDay());
        return dt.toISOString().slice(0, 10);
      }
      return d;
    };

    const buckets = new Map<string, { rows: CfPiece[] }>();
    for (const p of rows) {
      if (!p.date) continue;
      const k = key(p.date);
      if (!buckets.has(k)) buckets.set(k, { rows: [] });
      buckets.get(k)!.rows.push(p);
    }

    return [...buckets.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([bucket, { rows: rs }]) => {
        const tats = rs.map((p) => this.tat(p)).filter((n): n is number => n != null);
        return {
          bucket,
          allotted: rs.length,
          submitted: rs.filter((p) => this.isSubmitted(p)).length,
          verified: rs.filter((p) => this.isVerified(p)).length,
          published: rs.filter((p) => this.isPublished(p)).length,
          sentBack: rs.filter((p) => this.isSentBack(p)).length,
          yahoo: rs.filter((p) => p.yahoo === true).length,
          nonYahoo: rs.filter((p) => p.yahoo === false).length,
          medianTatHours: median(tats),
        };
      });
  }

  async getFunnel(params: CfFilterParams): Promise<FunnelStage[]> {
    const rows = await this.filter(params);

    // Counted as "reached at least this far", so a later stage implies every
    // earlier one. Without that, pieces the source published while leaving the
    // editorial status blank make Published exceed Verified and the funnel
    // reports a conversion above 100%.
    const published = (p: CfPiece) => this.isPublished(p);
    const verified = (p: CfPiece) => this.isVerified(p) || published(p);
    const editorial = (p: CfPiece) => this.reachedEditorial(p) || verified(p);
    const submitted = (p: CfPiece) => this.isSubmitted(p) || editorial(p);

    const stages: [string, number][] = [
      ['Allotted', rows.length],
      ['Submitted', rows.filter(submitted).length],
      ['Reached Editorial', rows.filter(editorial).length],
      ['Verified', rows.filter(verified).length],
      ['Published', rows.filter(published).length],
    ];
    return stages.map(([stage, count], i) => {
      const prev = i === 0 ? count : stages[i - 1][1];
      return {
        stage,
        count,
        conversion: pct(count, prev),
        dropped: Math.max(0, prev - count),
      };
    });
  }

  async getPending(params: CfFilterParams): Promise<PendingResult> {
    const rows = await this.filter(params);
    const resolve = await this.nameResolver();
    const now = new Date();

    const items: PendingItem[] = [];
    for (const p of rows) {
      const stage = this.pendingStage(p, now);
      if (!stage) continue;
      const item = this.toPendingItem(p, stage, now);
      item.pendingWith = resolve(item.pendingWith, item.division);
      items.push(item);
    }
    items.sort((a, b) => b.ageingHours - a.ageingHours);

    const byStage = new Map<string, number[]>();
    for (const it of items) {
      if (!byStage.has(it.stage)) byStage.set(it.stage, []);
      byStage.get(it.stage)!.push(it.ageingHours);
    }
    const order = ['Awaiting Submission', 'Awaiting Editorial', 'Sent Back', 'Awaiting Live'];
    const buckets = order
      .filter((s) => byStage.has(s))
      .map((stage) => {
        const ages = byStage.get(stage)!;
        return {
          stage,
          count: ages.length,
          medianAgeHours: median(ages),
          oldestAgeHours: round(Math.max(...ages)),
        };
      });

    const divMap = new Map<string, { awaitingSubmission: number; awaitingEditorial: number; awaitingLive: number; total: number }>();
    for (const it of items) {
      if (!divMap.has(it.division)) {
        divMap.set(it.division, { awaitingSubmission: 0, awaitingEditorial: 0, awaitingLive: 0, total: 0 });
      }
      const d = divMap.get(it.division)!;
      if (it.stage === 'Awaiting Submission') d.awaitingSubmission++;
      // An open send-back is work sitting in the editorial loop.
      else if (it.stage === 'Awaiting Editorial' || it.stage === 'Sent Back') d.awaitingEditorial++;
      else d.awaitingLive++;
      d.total++;
    }

    const ageCounts = new Map<string, number>();
    for (const it of items) {
      const b = band(it.ageingHours, AGE_BANDS);
      ageCounts.set(b, (ageCounts.get(b) ?? 0) + 1);
    }

    return {
      buckets,
      byDivision: [...divMap.entries()]
        .map(([division, v]) => ({ division, ...v }))
        .sort((a, b) => b.total - a.total),
      ageBands: AGE_BANDS.map(([label]) => ({ band: label, count: ageCounts.get(label) ?? 0 })),
      items: items.slice(0, 300),
    };
  }

  async getWriterStats(params: CfFilterParams): Promise<WriterStats[]> {
    const rows = await this.filter(params);
    const resolve = await this.nameResolver();
    const now = new Date();

    const map = new Map<string, { division: Map<string, number>; rows: CfPiece[] }>();
    for (const p of rows) {
      if (p.writer === 'Unknown') continue;
      const name = resolve(p.writer, p.division);
      if (!map.has(name)) map.set(name, { division: new Map(), rows: [] });
      const e = map.get(name)!;
      e.rows.push(p);
      e.division.set(p.division, (e.division.get(p.division) ?? 0) + 1);
    }

    return [...map.entries()]
      .map(([writer, { division, rows: rs }]) => {
        const tats = rs.map((p) => this.tat(p)).filter((n): n is number => n != null);
        const writeTimes = rs
          .map((p) => this.writeHours(p))
          .filter((n): n is number => n != null);
        const submitted = rs.filter((p) => this.isSubmitted(p)).length;
        const sentBack = rs.filter((p) => this.isSentBack(p)).length;
        return {
          writer,
          division: [...division.entries()].sort((a, b) => b[1] - a[1])[0][0],
          allotted: rs.length,
          submitted,
          verified: rs.filter((p) => this.isVerified(p)).length,
          published: rs.filter((p) => this.isPublished(p)).length,
          sentBack,
          sendBackRate: pct(sentBack, submitted),
          yahoo: rs.filter((p) => p.yahoo === true).length,
          nonYahoo: rs.filter((p) => p.yahoo === false).length,
          medianTatHours: median(tats),
          medianWriteHours: medianOrNull(writeTimes),
          submissionRate: pct(submitted, rs.length),
          pending: rs.filter((p) => this.pendingStage(p, now) !== null).length,
        };
      })
      .sort((a, b) => b.allotted - a.allotted);
  }

  async getEditorStats(params: CfFilterParams): Promise<EditorStats[]> {
    const rows = await this.filter(params);
    const resolve = await this.nameResolver();

    const map = new Map<string, { division: Map<string, number>; rows: CfPiece[] }>();
    for (const p of rows) {
      if (!this.reachedEditorial(p) || p.editor === 'Unknown') continue;
      const name = resolve(p.editor, p.division);
      if (!map.has(name)) map.set(name, { division: new Map(), rows: [] });
      const e = map.get(name)!;
      e.rows.push(p);
      e.division.set(p.division, (e.division.get(p.division) ?? 0) + 1);
    }

    return [...map.entries()]
      .map(([editor, { division, rows: rs }]) => {
        const reviews = rs
          .map((p) => hoursBetween(p.submittedAt, p.editorAt))
          .filter((n): n is number => n != null);
        const sentBack = rs.filter((p) => this.isSentBack(p)).length;
        return {
          editor,
          division: [...division.entries()].sort((a, b) => b[1] - a[1])[0][0],
          handled: rs.length,
          verified: rs.filter((p) => this.isVerified(p)).length,
          sentBack,
          sendBackRate: pct(sentBack, rs.length),
          secondPass: rs.filter((p) => !!p.editorAt2).length,
          yahoo: rs.filter((p) => p.yahoo === true).length,
          nonYahoo: rs.filter((p) => p.yahoo === false).length,
          medianReviewHours: medianOrNull(reviews),
        };
      })
      .sort((a, b) => b.handled - a.handled);
  }

  async getAllotterStats(params: CfFilterParams): Promise<AllotterStats[]> {
    const rows = await this.filter(params);
    const resolve = await this.nameResolver();

    const map = new Map<string, { division: Map<string, number>; rows: CfPiece[] }>();
    for (const p of rows) {
      if (p.allottedBy === 'Unknown') continue;
      const name = resolve(p.allottedBy, p.division);
      if (!map.has(name)) map.set(name, { division: new Map(), rows: [] });
      const e = map.get(name)!;
      e.rows.push(p);
      e.division.set(p.division, (e.division.get(p.division) ?? 0) + 1);
    }

    return [...map.entries()]
      .map(([allotter, { division, rows: rs }]) => {
        const submitted = rs.filter((p) => this.isSubmitted(p)).length;
        return {
          allotter,
          division: [...division.entries()].sort((a, b) => b[1] - a[1])[0][0],
          allotted: rs.length,
          submitted,
          published: rs.filter((p) => this.isPublished(p)).length,
          submissionRate: pct(submitted, rs.length),
          neverPicked: rs.length - submitted,
        };
      })
      .sort((a, b) => b.allotted - a.allotted);
  }

  async getSendBacks(params: CfFilterParams): Promise<SendBackResult> {
    const rows = await this.filter(params);
    const resolve = await this.nameResolver();
    const now = new Date();

    const reachedEd = rows.filter((p) => this.reachedEditorial(p));
    const sent = rows.filter((p) => this.isSentBack(p));

    const reasonMap = new Map<string, { count: number; rework: number[] }>();
    for (const p of sent) {
      const reason = p.sbReason || 'Unspecified';
      if (!reasonMap.has(reason)) reasonMap.set(reason, { count: 0, rework: [] });
      const e = reasonMap.get(reason)!;
      e.count++;
      // Only pieces that came back have a measurable rework gap; the rest are
      // still out with the writer.
      const rework = p.sbHours ?? hoursBetween(p.editorAt, p.editorAt2);
      if (rework != null) e.rework.push(rework);
    }
    const reasons = [...reasonMap.entries()]
      .map(([reason, e]) => ({
        reason,
        count: e.count,
        share: pct(e.count, sent.length),
        medianReworkHours: medianOrNull(e.rework),
      }))
      .sort((a, b) => b.count - a.count);

    const group = <T extends string>(
      keyOf: (p: CfPiece) => string,
      pool: CfPiece[],
    ) => {
      const m = new Map<string, { total: number; sb: number }>();
      for (const p of pool) {
        const k = keyOf(p);
        if (!k || k === 'Unknown') continue;
        if (!m.has(k)) m.set(k, { total: 0, sb: 0 });
        const e = m.get(k)!;
        e.total++;
        if (this.isSentBack(p)) e.sb++;
      }
      return m;
    };

    const byEditorMap = group((p) => resolve(p.editor, p.division), reachedEd);
    const byWriterMap = group((p) => resolve(p.writer, p.division), rows.filter((p) => this.isSubmitted(p)));
    const byDivisionMap = group((p) => p.division, reachedEd);

    const trendMap = new Map<string, { total: number; sb: number }>();
    for (const p of reachedEd) {
      if (!p.date) continue;
      if (!trendMap.has(p.date)) trendMap.set(p.date, { total: 0, sb: 0 });
      const e = trendMap.get(p.date)!;
      e.total++;
      if (this.isSentBack(p)) e.sb++;
    }

    const open = rows
      .filter((p) => this.isOpenSendBack(p) && !this.isKilled(p))
      .map((p) => {
        const item = this.toPendingItem(p, 'Sent Back', now);
        item.pendingWith = resolve(item.pendingWith, item.division);
        return item;
      })
      .sort((a, b) => b.ageingHours - a.ageingHours);

    return {
      total: sent.length,
      rate: pct(sent.length, reachedEd.length),
      reasons,
      byEditor: [...byEditorMap.entries()]
        .map(([editor, v]) => ({ editor, sentBack: v.sb, handled: v.total, rate: pct(v.sb, v.total) }))
        .sort((a, b) => b.sentBack - a.sentBack),
      byWriter: [...byWriterMap.entries()]
        .map(([writer, v]) => ({ writer, sentBack: v.sb, submitted: v.total, rate: pct(v.sb, v.total) }))
        .sort((a, b) => b.sentBack - a.sentBack),
      byDivision: [...byDivisionMap.entries()]
        .map(([division, v]) => ({ division, sentBack: v.sb, handled: v.total, rate: pct(v.sb, v.total) }))
        .sort((a, b) => b.sentBack - a.sentBack),
      trend: [...trendMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([bucket, v]) => ({ bucket, sentBack: v.sb, handled: v.total, rate: pct(v.sb, v.total) })),
      openSendBacks: open.slice(0, 100),
    };
  }

  async getTat(params: CfFilterParams): Promise<TatResult> {
    const rows = await this.filter(params);
    const resolve = await this.nameResolver();

    const withTat = rows
      .map((p) => ({ p, t: this.tat(p) }))
      .filter((x): x is { p: CfPiece; t: number } => x.t != null);
    const all = withTat.map((x) => x.t);

    const stat = (label: string, vals: number[]): TatStat => ({
      label,
      count: vals.length,
      median: median(vals),
      p90: percentile(vals, 90),
      max: vals.length ? round(Math.max(...vals)) : 0,
    });

    const groupStat = (keyOf: (p: CfPiece) => string, minCount = 1): TatStat[] => {
      const m = new Map<string, number[]>();
      for (const { p, t } of withTat) {
        const k = keyOf(p);
        if (!k || k === 'Unknown') continue;
        if (!m.has(k)) m.set(k, []);
        m.get(k)!.push(t);
      }
      return [...m.entries()]
        .filter(([, v]) => v.length >= minCount)
        .map(([k, v]) => stat(k, v))
        .sort((a, b) => b.median - a.median);
    };

    const bandCounts = new Map<string, number>();
    for (const t of all) {
      const b = band(t, TAT_BANDS);
      bandCounts.set(b, (bandCounts.get(b) ?? 0) + 1);
    }

    const legs: [string, (p: CfPiece) => number | null][] = [
      ['Allotment → Submission', (p) => this.writeHours(p)],
      ['Submission → Editorial', (p) => hoursBetween(p.submittedAt, p.editorAt)],
      ['Send-back rework', (p) => p.sbHours ?? hoursBetween(p.editorAt, p.editorAt2)],
      ['Editorial → Live', (p) => hoursBetween(p.editorAt2 || p.editorAt, p.liveAt)],
    ];

    return {
      overall: stat('All', all),
      distribution: TAT_BANDS.map(([label]) => ({ band: label, count: bandCounts.get(label) ?? 0 })),
      byDivision: groupStat((p) => p.division),
      byArticleType: groupStat((p) => p.articleType),
      byWriter: groupStat((p) => resolve(p.writer, p.division), 3),
      byEditor: groupStat((p) => resolve(p.editor, p.division), 3),
      stages: legs.map(([stage, fn]) => {
        const vals = rows.map(fn).filter((n): n is number => n != null);
        return {
          stage,
          median: medianOrNull(vals),
          p90: percentileOrNull(vals, 90),
          count: vals.length,
        };
      }),
      slowest: withTat
        .sort((a, b) => b.t - a.t)
        .slice(0, 25)
        .map(({ p, t }) => ({
          id: p.id,
          division: p.division,
          title: p.title,
          writer: resolve(p.writer, p.division),
          editor: resolve(p.editor, p.division),
          tatHours: round(t),
          stagingLink: p.stagingLink,
        })),
    };
  }

  async getDivisions(params: CfFilterParams): Promise<DivisionStats[]> {
    const rows = await this.filter(params);
    const resolve = await this.nameResolver();
    const now = new Date();

    const m = new Map<string, CfPiece[]>();
    for (const p of rows) {
      if (!m.has(p.division)) m.set(p.division, []);
      m.get(p.division)!.push(p);
    }

    return [...m.entries()]
      .map(([division, rs]) => {
        const tats = rs.map((p) => this.tat(p)).filter((n): n is number => n != null);
        const yahoo = rs.filter((p) => p.yahoo === true).length;
        const yahooKnown = rs.filter((p) => p.yahoo !== null).length;
        const published = rs.filter((p) => this.isPublished(p)).length;
        return {
          division,
          allotted: rs.length,
          submitted: rs.filter((p) => this.isSubmitted(p)).length,
          verified: rs.filter((p) => this.isVerified(p)).length,
          published,
          sentBack: rs.filter((p) => this.isSentBack(p)).length,
          pending: rs.filter((p) => this.pendingStage(p, now) !== null).length,
          yahoo,
          yahooShare: pct(yahoo, yahooKnown),
          publishRate: pct(published, rs.length),
          medianTatHours: median(tats),
          writers: new Set(rs.filter((p) => p.writer !== 'Unknown').map((p) => resolve(p.writer, p.division))).size,
          editors: new Set(rs.filter((p) => p.editor !== 'Unknown').map((p) => resolve(p.editor, p.division))).size,
        };
      })
      .sort((a, b) => b.allotted - a.allotted);
  }

  async getArticleTypes(params: CfFilterParams): Promise<ArticleTypeEntry[]> {
    const rows = await this.filter(params);
    const m = new Map<string, CfPiece[]>();
    for (const p of rows) {
      if (!m.has(p.articleType)) m.set(p.articleType, []);
      m.get(p.articleType)!.push(p);
    }
    return [...m.entries()]
      .map(([articleType, rs]) => {
        const tats = rs.map((p) => this.tat(p)).filter((n): n is number => n != null);
        return {
          articleType,
          count: rs.length,
          share: pct(rs.length, rows.length),
          published: rs.filter((p) => this.isPublished(p)).length,
          sentBack: rs.filter((p) => this.isSentBack(p)).length,
          medianTatHours: median(tats),
          yahoo: rs.filter((p) => p.yahoo === true).length,
        };
      })
      .sort((a, b) => b.count - a.count);
  }

  async getYahooSplit(params: CfFilterParams): Promise<YahooSplitResult> {
    const rows = await this.filter(params);

    const side = (pool: CfPiece[]) => {
      const tats = pool.map((p) => this.tat(p)).filter((n): n is number => n != null);
      const reachedEd = pool.filter((p) => this.reachedEditorial(p)).length;
      return {
        count: pool.length,
        published: pool.filter((p) => this.isPublished(p)).length,
        medianTatHours: median(tats),
        sendBackRate: pct(pool.filter((p) => this.isSentBack(p)).length, reachedEd),
      };
    };

    const divMap = new Map<string, { yahoo: number; nonYahoo: number; unset: number }>();
    for (const p of rows) {
      if (!divMap.has(p.division)) divMap.set(p.division, { yahoo: 0, nonYahoo: 0, unset: 0 });
      const d = divMap.get(p.division)!;
      if (p.yahoo === true) d.yahoo++;
      else if (p.yahoo === false) d.nonYahoo++;
      else d.unset++;
    }

    const trendMap = new Map<string, { yahoo: number; nonYahoo: number }>();
    for (const p of rows) {
      if (!p.date) continue;
      if (!trendMap.has(p.date)) trendMap.set(p.date, { yahoo: 0, nonYahoo: 0 });
      const e = trendMap.get(p.date)!;
      if (p.yahoo === true) e.yahoo++;
      else if (p.yahoo === false) e.nonYahoo++;
    }

    return {
      yahoo: side(rows.filter((p) => p.yahoo === true)),
      nonYahoo: side(rows.filter((p) => p.yahoo === false)),
      unset: rows.filter((p) => p.yahoo === null).length,
      byDivision: [...divMap.entries()]
        .map(([division, v]) => ({
          division,
          ...v,
          yahooShare: pct(v.yahoo, v.yahoo + v.nonYahoo),
        }))
        .sort((a, b) => b.yahoo + b.nonYahoo - (a.yahoo + a.nonYahoo)),
      trend: [...trendMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([bucket, v]) => ({ bucket, ...v })),
    };
  }

  async getRoster(params: CfFilterParams): Promise<RosterResult> {
    const [roster, rows] = await Promise.all([this.rosterRepo.find(), this.filter(params)]);
    const resolve = await this.nameResolver();
    const now = new Date();
    const todayName = WEEKDAYS[now.getDay()];

    // Activity index, keyed on the resolved identity so roster and data agree.
    const activity = new Map<string, { active: number; last: string | null; count: number; division: string }>();
    const touch = (raw: string, division: string, p: CfPiece) => {
      if (!raw || raw === 'Unknown') return;
      const name = resolve(raw, division);
      if (!activity.has(name)) activity.set(name, { active: 0, last: null, count: 0, division });
      const a = activity.get(name)!;
      a.count++;
      if (this.pendingStage(p, now) !== null) a.active++;
      if (p.date && (!a.last || p.date > a.last)) a.last = p.date;
    };
    for (const p of rows) {
      touch(p.writer, p.division, p);
      touch(p.editor, p.division, p);
      touch(p.allottedBy, p.division, p);
    }

    const people = roster
      .filter((r) => !params.divisions?.length || params.divisions.includes(r.division))
      .map((r) => {
        const name = resolve(r.name, r.division);
        const a = activity.get(name);
        return {
          id: r.id,
          division: r.division,
          name,
          role: r.role,
          roleGroup: r.roleGroup,
          weekoff: r.weekoff,
          shift: r.shift,
          email: r.email,
          dailyTarget: r.dailyTarget,
          offToday: r.weekoff.toLowerCase().includes(todayName.toLowerCase()),
          activePieces: a?.active ?? 0,
          lastActiveDate: a?.last ?? null,
        };
      })
      .sort((a, b) => a.division.localeCompare(b.division) || a.name.localeCompare(b.name));

    const divMap = new Map<string, { total: number; writers: number; editors: number; offToday: number }>();
    for (const p of people) {
      if (!divMap.has(p.division)) divMap.set(p.division, { total: 0, writers: 0, editors: 0, offToday: 0 });
      const d = divMap.get(p.division)!;
      d.total++;
      if (p.roleGroup === 'writer') d.writers++;
      if (p.roleGroup === 'editor') d.editors++;
      if (p.offToday) d.offToday++;
    }

    const idle = people
      .filter((p) => p.roleGroup === 'writer' || p.roleGroup === 'editor')
      .map((p) => ({
        name: p.name,
        division: p.division,
        role: p.role,
        lastActiveDate: p.lastActiveDate,
        daysIdle: p.lastActiveDate
          ? Math.floor((now.getTime() - new Date(p.lastActiveDate).getTime()) / 86400000)
          : null,
      }))
      .filter((p) => p.daysIdle === null || p.daysIdle >= 3)
      .sort((a, b) => (b.daysIdle ?? 9999) - (a.daysIdle ?? 9999));

    // People doing the work who are on nobody's Division Info tab — usually a
    // roster that has fallen behind, occasionally a name spelt a new way.
    const rosterNames = new Set(people.map((p) => p.name.toLowerCase()));
    const unrostered = [...activity.entries()]
      .filter(([name]) => !rosterNames.has(name.toLowerCase()))
      .map(([name, a]) => ({ name, division: a.division, role: '', pieces: a.count }))
      .filter((u) => u.pieces >= 2)
      .sort((a, b) => b.pieces - a.pieces);

    // Names that look like the same person recorded in two divisions
    // ("Yash" in College Football, "Yash Kotak" in NFL). These are NOT merged
    // automatically: across divisions a shared first name can equally well be
    // two different people, and silently fusing them would overstate one
    // person's output. Surfaced so the rosters can settle it.
    const byFirstToken = new Map<string, Map<string, { division: string; pieces: number }>>();
    for (const [name, a] of activity) {
      const first = name.toLowerCase().split(/[\s.]+/)[0];
      if (!first) continue;
      if (!byFirstToken.has(first)) byFirstToken.set(first, new Map());
      byFirstToken.get(first)!.set(name, { division: a.division, pieces: a.count });
    }
    const nameVariants = [...byFirstToken.values()]
      .filter((m) => m.size > 1)
      .map((m) => ({
        variants: [...m.entries()].map(([name, v]) => ({
          name,
          division: v.division,
          pieces: v.pieces,
        })),
      }))
      // Only worth raising when the variants sit in different divisions — the
      // within-division case has already been resolved.
      .filter((g) => new Set(g.variants.map((v) => v.division)).size > 1)
      .sort(
        (a, b) =>
          b.variants.reduce((s, v) => s + v.pieces, 0) -
          a.variants.reduce((s, v) => s + v.pieces, 0),
      );

    return {
      people,
      byDivision: [...divMap.entries()]
        .map(([division, v]) => ({ division, ...v }))
        .sort((a, b) => b.total - a.total),
      idle,
      unrostered,
      nameVariants,
    };
  }

  async getInsights(params: CfFilterParams): Promise<InsightsResult> {
    const rows = await this.filter(params);
    const resolve = await this.nameResolver();
    const now = new Date();

    // Weekday rhythm, anchored on the allotment day.
    const wd = new Map<number, CfPiece[]>();
    for (const p of rows) {
      if (!p.date) continue;
      const d = new Date(p.date).getDay();
      if (!wd.has(d)) wd.set(d, []);
      wd.get(d)!.push(p);
    }
    const weekdayRhythm = WEEKDAYS.map((weekday, i) => {
      const rs = wd.get(i) ?? [];
      const tats = rs.map((p) => this.tat(p)).filter((n): n is number => n != null);
      return {
        weekday,
        allotted: rs.length,
        submitted: rs.filter((p) => this.isSubmitted(p)).length,
        published: rs.filter((p) => this.isPublished(p)).length,
        medianTatHours: median(tats),
      };
    });

    const heat = new Map<string, number>();
    for (const p of rows) {
      if (!p.submittedAt) continue;
      const d = new Date(p.submittedAt);
      const k = `${d.getDay()}-${d.getHours()}`;
      heat.set(k, (heat.get(k) ?? 0) + 1);
    }
    const submissionHeatmap = [...heat.entries()].map(([k, count]) => {
      const [weekday, hour] = k.split('-').map(Number);
      return { weekday, hour, count };
    });

    // Anything still open past the point where it stops being "in progress".
    const stuck: PendingItem[] = [];
    for (const p of rows) {
      const stage = this.pendingStage(p, now);
      if (!stage) continue;
      const item = this.toPendingItem(p, stage, now);
      if (item.ageingHours < 48) continue;
      item.pendingWith = resolve(item.pendingWith, item.division);
      stuck.push(item);
    }
    stuck.sort((a, b) => b.ageingHours - a.ageingHours);

    const dupMap = new Map<string, CfPiece[]>();
    for (const p of rows) {
      if (!p.titleNorm) continue;
      if (!dupMap.has(p.titleNorm)) dupMap.set(p.titleNorm, []);
      dupMap.get(p.titleNorm)!.push(p);
    }
    const duplicates = [...dupMap.entries()]
      .filter(([, v]) => v.length > 1)
      .map(([titleNorm, v]) => ({
        titleNorm,
        title: v[0].title,
        count: v.length,
        divisions: [...new Set(v.map((p) => p.division))],
        writers: [...new Set(v.map((p) => resolve(p.writer, p.division)))],
        ids: v.map((p) => p.id),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 50);

    // Gaps worth chasing in the source sheets rather than silently absorbing.
    const dataQuality = [
      {
        issue: 'Missing Yahoo flag',
        count: rows.filter((p) => p.yahoo === null).length,
        detail: 'Syndication split cannot be computed for these pieces',
      },
      {
        issue: 'Missing article type',
        count: rows.filter((p) => p.articleType === 'Unknown').length,
        detail: 'Excluded from the article-type mix',
      },
      {
        issue: 'No submission timestamp',
        count: rows.filter((p) => !p.submittedAt && this.reachedEditorial(p)).length,
        detail: 'Reached editorial without a submission stamp — write-time unmeasurable',
      },
      {
        issue: 'Allotment recorded without a time',
        count: rows.filter((p) => p.allottedAt && !this.hasAllotmentTime(p)).length,
        detail:
          'Source records allotment as a date only, so writing time is measured from midnight — these are excluded from the allotment→submission leg',
      },
      {
        issue: 'No date anywhere on the piece',
        count: rows.filter((p) => !p.date).length,
        detail:
          'Every lifecycle timestamp is blank in the source, so these cannot be placed on a timeline and drop out of any date-filtered view',
      },
      {
        issue: 'Verified but never published',
        count: rows.filter((p) => this.isVerified(p) && !this.isPublished(p)).length,
        detail: 'Cleared editorial with no publication date recorded',
      },
      {
        issue: 'No editor assigned',
        count: rows.filter((p) => this.isSubmitted(p) && p.editor === 'Unknown').length,
        detail: 'Submitted work with an empty Editor column',
      },
    ].filter((d) => d.count > 0);

    return {
      weekdayRhythm,
      submissionHeatmap,
      stuck: stuck.slice(0, 100),
      duplicates,
      dataQuality,
    };
  }
}
