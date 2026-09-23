import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { google } from 'googleapis';
import {
  clean,
  computeRowHash,
  parseDateOnly,
  parseDateTime,
  parseNumber,
} from '../production/normalization';
import { ResPerson } from './entities/res-person.entity';
import { ResLeave } from './entities/res-leave.entity';
import { ResDivisionQuota } from './entities/res-division-quota.entity';
import { ResourcesSyncStatus } from './types';

type Row = any[];

/** Column index by header text; the n8n lane writes these headers verbatim. */
function headerIndex(header: Row): (name: string) => number {
  const cells = header.map((h) => clean(h).toLowerCase());
  return (name: string) => cells.indexOf(name.toLowerCase());
}

/**
 * The lane writes dates as "2026-09-13" text. Taken as-is rather than through
 * a Date, which would shift the day on a server west of UTC.
 */
function isoDay(raw: any): string | null {
  const s = clean(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return parseDateOnly(raw);
}

function intOr(raw: any, fallback: number): number {
  const n = parseNumber(raw);
  return n == null ? fallback : Math.round(n);
}

/**
 * Syncs people, leave and quotas from the aggregate sheet's People / Leaves /
 * Quotas tabs, which the n8n resources lane rebuilds from the managers'
 * Dynamic Schedule workbook. All parsing of that workbook happens in n8n; this
 * side only maps columns.
 */
@Injectable()
export class ResourcesSyncService implements OnModuleInit {
  private readonly logger = new Logger(ResourcesSyncService.name);

  private lastSyncTime: Date | null = null;
  private syncing = false;
  private lastError: string | null = null;

  private resolveFirstSync!: () => void;
  /** Settles once the first sync attempt after boot has finished, either way. */
  readonly firstSync = new Promise<void>((r) => (this.resolveFirstSync = r));

  constructor(
    @InjectRepository(ResPerson) private readonly peopleRepo: Repository<ResPerson>,
    @InjectRepository(ResLeave) private readonly leaveRepo: Repository<ResLeave>,
    @InjectRepository(ResDivisionQuota) private readonly quotaRepo: Repository<ResDivisionQuota>,
  ) {}

  /** Its own id when set; otherwise the Critical Flow aggregate, where the lane writes today. */
  private sheetId(): string | undefined {
    return process.env.RESOURCES_SHEET_ID || process.env.CF_SHEET_ID || undefined;
  }

  isConfigured(): boolean {
    return !!this.sheetId();
  }

  async onModuleInit() {
    this.sync()
      .catch((e) => this.logger.error(`Initial resources sync failed: ${e.message}`))
      .finally(() => this.resolveFirstSync());
  }

  @Cron('*/10 * * * *')
  async scheduledSync() {
    await this.sync();
  }

  getStatus(): ResourcesSyncStatus {
    return {
      sheetConfigured: this.isConfigured(),
      lastSyncTime: this.lastSyncTime?.toISOString() ?? null,
      syncing: this.syncing,
      error: this.lastError,
    };
  }

  async sync(): Promise<void> {
    const sheetId = this.sheetId();
    if (!sheetId) {
      this.logger.warn('RESOURCES_SHEET_ID / CF_SHEET_ID not configured, skipping resources sync');
      return;
    }
    if (this.syncing) return;
    this.syncing = true;
    this.lastError = null;
    try {
      const sheets = google.sheets({
        version: 'v4',
        auth: new google.auth.GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        }),
      });
      const res = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: sheetId,
        ranges: ["'People'!A:P", "'Leaves'!A:H", "'Quotas'!A:J"],
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'SERIAL_NUMBER',
      });
      const [peopleRows, leaveRows, quotaRows] = (res.data.valueRanges || []).map(
        (vr) => (vr.values as Row[]) || [],
      );

      const people = this.parsePeople(peopleRows || []);
      // An empty People tab means the lane has not run or failed to write, not
      // that everyone left — keep what the board already has.
      if (!people.length) {
        this.lastError = 'People tab is empty — has the n8n resources lane run?';
        this.logger.warn(`Resources: ${this.lastError}`);
        return;
      }
      await this.replaceTable(this.peopleRepo, ResPerson, people, 'people');
      await this.replaceTable(this.leaveRepo, ResLeave, this.parseLeaves(leaveRows || []), 'leave records');

      const quotas = this.parseQuotas(quotaRows || []);
      if (quotas.length) {
        await this.replaceTable(this.quotaRepo, ResDivisionQuota, quotas, 'division quotas');
      } else {
        this.logger.warn('Resources: Quotas tab is empty, keeping the previous quotas');
      }

      this.lastSyncTime = new Date();
      this.logger.log(
        `Resources sync complete: ${people.length} people, ` +
          `${await this.leaveRepo.count()} leave records, ${await this.quotaRepo.count()} quotas`,
      );
    } catch (e: any) {
      // A failed read (tabs not created yet, access revoked) leaves the
      // previous data in place.
      this.lastError = e.message;
      this.logger.error(`Resources sync failed: ${e.message}`);
    } finally {
      this.syncing = false;
    }
  }

  private parsePeople(rows: Row[]): ResPerson[] {
    if (rows.length < 2) return [];
    const at = headerIndex(rows[0]);
    const c = {
      id: at('ID'), name: at('Name'), division: at('Primary Division'), subFeed: at('Sub Feed'),
      secondary: at('Secondary Divisions'), role: at('Role'), roleGroup: at('Role Group'),
      pod: at('Pod'), shift: at('Shift'), clock: at('Shift Clock'), weekoff: at('Week Off'),
      plan: at('Week Plan'), backup: at('Backup'), status: at('Status'), sources: at('Sources'),
      flags: at('Flags'),
    };
    if (c.id < 0 || c.name < 0 || c.division < 0) {
      this.logger.error(`People tab: missing ID / Name / Primary Division headers`);
      return [];
    }
    const out: ResPerson[] = [];
    for (const row of rows.slice(1)) {
      const t = (i: number) => (i < 0 ? '' : clean(row[i]));
      const id = t(c.id);
      const name = t(c.name);
      if (!id || !name) continue;
      const e = new ResPerson();
      Object.assign(e, {
        id,
        name,
        primaryDivision: t(c.division) || 'Unknown',
        subFeed: t(c.subFeed),
        secondaryDivisions: t(c.secondary).split(',').map((s) => s.trim()).filter(Boolean),
        role: t(c.role),
        roleGroup: t(c.roleGroup) || 'other',
        pod: t(c.pod),
        shift: t(c.shift),
        shiftClock: t(c.clock),
        weekoff: t(c.weekoff),
        weekPlan: t(c.plan) || '{}',
        backup: t(c.backup),
        status: t(c.status),
        sources: t(c.sources),
        flags: t(c.flags),
        rawHash: computeRowHash(row),
      });
      out.push(e);
    }
    return out;
  }

  private parseLeaves(rows: Row[]): ResLeave[] {
    if (rows.length < 2) return [];
    const at = headerIndex(rows[0]);
    const c = {
      id: at('ID'), name: at('Name'), role: at('Role'), start: at('Leave Start'),
      end: at('Leave End'), days: at('Days'), type: at('Type'), logged: at('Logged At'),
    };
    const out: ResLeave[] = [];
    for (const row of rows.slice(1)) {
      const t = (i: number) => (i < 0 ? '' : clean(row[i]));
      const id = t(c.id);
      const name = t(c.name);
      const start = c.start < 0 ? null : isoDay(row[c.start]);
      if (!id || !name || !start) continue;
      const e = new ResLeave();
      Object.assign(e, {
        id,
        name,
        roleTag: t(c.role),
        leaveStart: start,
        leaveEnd: (c.end < 0 ? null : isoDay(row[c.end])) || start,
        days: c.days < 0 ? null : parseNumber(row[c.days]),
        type: t(c.type) || 'Unspecified',
        loggedAt: c.logged < 0 ? null : parseDateTime(row[c.logged]),
        rawHash: computeRowHash(row),
      });
      out.push(e);
    }
    return out;
  }

  private parseQuotas(rows: Row[]): ResDivisionQuota[] {
    if (rows.length < 2) return [];
    const at = headerIndex(rows[0]);
    const c = {
      id: at('ID'), division: at('Division'), subFeed: at('Sub Feed'), source: at('Source Name'),
      emp: at('EMP'), lnp: at('LNP'), total: at('Total'), chart: at('Editorial Chart Total'),
      poc: at('PoC'), arch: at('Architecture'),
    };
    const out: ResDivisionQuota[] = [];
    for (const row of rows.slice(1)) {
      const t = (i: number) => (i < 0 ? '' : clean(row[i]));
      const id = t(c.id);
      const division = t(c.division);
      if (!id || !division) continue;
      const emp = intOr(row[c.emp], 0);
      const lnp = intOr(row[c.lnp], 0);
      const chart = c.chart < 0 ? null : parseNumber(row[c.chart]);
      const e = new ResDivisionQuota();
      Object.assign(e, {
        id,
        division,
        subFeed: t(c.subFeed),
        sourceName: t(c.source),
        emp,
        lnp,
        total: intOr(row[c.total], emp + lnp),
        editorialChartTotal: chart == null ? null : Math.round(chart),
        poc: t(c.poc),
        architecture: t(c.arch),
        rawHash: computeRowHash(row),
      });
      out.push(e);
    }
    return out;
  }

  /** Hash-diff upsert, then delete whatever the sheet no longer lists. */
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
    // Keyed by id, last wins: one upsert batch must not target an id twice.
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
      this.logger.log(`Resources ${label}: upserted ${rows.length} changed rows`);
    }
    const stale = [...hashes.keys()].filter((id) => !ids.has(id));
    for (let i = 0; i < stale.length; i += 500) {
      await repo.delete(stale.slice(i, i + 500));
    }
    if (stale.length) this.logger.log(`Resources ${label}: removed ${stale.length} stale rows`);
  }
}
