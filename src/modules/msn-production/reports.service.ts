import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MsnReportEod } from './entities/msn-report-eod.entity';
import { MsnReportEow } from './entities/msn-report-eow.entity';
import { MsnReportMtd } from './entities/msn-report-mtd.entity';
import { MsnReportTarget } from './entities/msn-report-target.entity';
import { PUBLICATIONS, REGION_TIERS } from './reports-config';

// ─────────────────────────────────────────────────────────────────────────────
// Value helpers — the heart of the "data only improves" guarantee.
//
// A scraper re-run may partially fail (a modal didn't dismiss, an export
// timed out) and emit 0 / '' / '-' for metrics it couldn't read. Those
// placeholder values must never clobber a real value from an earlier run,
// so every field is merged with: incoming wins only when it is meaningful
// (a finite, non-zero number). Otherwise the stored value is kept.
// ─────────────────────────────────────────────────────────────────────────────

/** Parse "1,234", "98%", 1234, "-" → number | null. */
function toNum(val: unknown): number | null {
  if (val === undefined || val === null) return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  const s = String(val).trim().replace(/,/g, '').replace(/%$/, '');
  if (!s || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** True when the incoming value should overwrite what is stored. */
function isMeaningful(n: number | null): boolean {
  return n !== null && n !== 0;
}

/** Latest-non-zero-wins for a numeric field (stored may be a pg bigint string). */
function mergeNum(
  incoming: unknown,
  stored: number | string | null | undefined,
): number | null {
  const inc = toNum(incoming);
  if (isMeaningful(inc)) return inc;
  const cur = toNum(stored ?? null);
  return cur;
}

/** Non-blank-wins for free-text fields (feed-list reliability etc.). */
function mergeText(
  incoming: unknown,
  stored: string | null | undefined,
): string {
  const inc = incoming === undefined || incoming === null ? '' : String(incoming).trim();
  if (inc && inc !== '-') return inc;
  return stored ?? '';
}

/**
 * Accepts ISO ("2026-06-30"), "30 June 2026", or a Date, → "yyyy-mm-dd".
 * Returns null when unparseable so callers can reject the payload loudly
 * instead of storing rows under a garbage key.
 */
function toIsoDate(val: unknown): string | null {
  if (!val) return null;
  if (val instanceof Date && !isNaN(val.getTime()))
    return val.toISOString().slice(0, 10);
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    // new Date('30 June 2026') parses in local time; format locally too so
    // the date never shifts across the UTC boundary.
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return null;
}

// ── Ingest payload shapes (validated manually — bodies are dynamic JSON) ──

interface EodRow {
  publication: string;
  followers?: unknown;
  feedHealthRate?: unknown;
  publishRate?: unknown;
  published?: {
    video?: unknown;
    gallery?: unknown;
    article?: unknown;
    total?: unknown;
  };
  views?: Record<string, Record<string, unknown>>;
  feedList?: Array<{
    region?: unknown;
    type?: unknown;
    reliability?: unknown;
    publishRate?: unknown;
  }>;
}

interface WeeklyRow {
  publication: string;
  articlePublished?: unknown;
  articleViews?: unknown;
  slideshowPublished?: unknown;
  slideshowViews?: unknown;
  videoPublished?: unknown;
  videoViews?: unknown;
  videoConsumedHours?: unknown;
}

interface MtdRow {
  publication: string;
  articleViews?: unknown;
  slideshowViews?: unknown;
  videoViews?: unknown;
  videoConsumedHours?: unknown;
}

export interface IngestResult {
  reportType: string;
  periodKey: string;
  received: number;
  written: number;
  skipped: string[];
}

@Injectable()
export class ReportsService implements OnModuleInit {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    @InjectRepository(MsnReportEod)
    private readonly eodRepo: Repository<MsnReportEod>,
    @InjectRepository(MsnReportEow)
    private readonly eowRepo: Repository<MsnReportEow>,
    @InjectRepository(MsnReportMtd)
    private readonly mtdRepo: Repository<MsnReportMtd>,
    @InjectRepository(MsnReportTarget)
    private readonly targetRepo: Repository<MsnReportTarget>,
  ) {}

  // ─────────────────────────── Targets / config ──────────────────────────

  /** Seed the targets table from the static defaults on first boot. */
  async onModuleInit(): Promise<void> {
    try {
      const count = await this.targetRepo.count();
      if (count > 0) return;
      const rows = Object.entries(PUBLICATIONS).map(([publication, cfg]) =>
        this.targetRepo.create({
          publication,
          shortName: cfg.shortName,
          tier: cfg.tier,
          articleTarget: cfg.targets.article,
          slideshowTarget: cfg.targets.slideshow,
          videoTarget: cfg.targets.video,
        }),
      );
      await this.targetRepo.save(rows);
      this.logger.log(`Seeded ${rows.length} report targets from defaults.`);
    } catch (err) {
      // Non-fatal: the table may not exist yet if DB_SYNC is off. The static
      // defaults still back getConfig() in that case.
      this.logger.warn(
        `Target seed skipped: ${(err as Error).message.split('\n')[0]}`,
      );
    }
  }

  /** Region tiers + per-publication config (DB targets, falling back to defaults). */
  async getConfig(): Promise<{
    regionTiers: Record<string, string[]>;
    publications: Record<
      string,
      {
        shortName: string;
        tier: string;
        targets: { article: number; slideshow: number; video: number };
      }
    >;
  }> {
    const publications: Record<
      string,
      {
        shortName: string;
        tier: string;
        targets: { article: number; slideshow: number; video: number };
      }
    > = {};

    // Start from static defaults so a brand-new / unseeded DB still works.
    for (const [pub, cfg] of Object.entries(PUBLICATIONS)) {
      publications[pub] = {
        shortName: cfg.shortName,
        tier: cfg.tier,
        targets: { ...cfg.targets },
      };
    }

    // Overlay any DB rows (the editable source of truth).
    let stored: MsnReportTarget[] = [];
    try {
      stored = await this.targetRepo.find();
    } catch {
      /* table missing (DB_SYNC off) — defaults only */
    }
    for (const t of stored) {
      publications[t.publication] = {
        shortName: t.shortName || t.publication,
        tier: t.tier || '',
        targets: {
          article: t.articleTarget,
          slideshow: t.slideshowTarget,
          video: t.videoTarget,
        },
      };
    }

    return { regionTiers: REGION_TIERS, publications };
  }

  async getTargets(): Promise<MsnReportTarget[]> {
    const rows = await this.targetRepo.find();
    // Present in the defaults' order (tier, then feed) for a stable editor UI.
    const order = Object.keys(PUBLICATIONS);
    return rows.sort((a, b) => {
      const ia = order.indexOf(a.publication);
      const ib = order.indexOf(b.publication);
      if (ia === -1 && ib === -1)
        return a.publication.localeCompare(b.publication);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  }

  /** Bulk upsert of targets from the editor. */
  async updateTargets(
    body: any,
  ): Promise<{ updated: number; targets: MsnReportTarget[] }> {
    const list = Array.isArray(body) ? body : body?.targets;
    if (!Array.isArray(list) || list.length === 0) {
      throw new BadRequestException('`targets` must be a non-empty array');
    }
    const toInt = (v: unknown): number => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    const rows: MsnReportTarget[] = [];
    for (const raw of list) {
      const publication = String(raw?.publication ?? '').trim();
      if (!publication) continue;
      rows.push(
        this.targetRepo.create({
          publication,
          shortName: String(raw?.shortName ?? publication).trim(),
          tier: String(raw?.tier ?? '').trim(),
          articleTarget: toInt(raw?.articleTarget),
          slideshowTarget: toInt(raw?.slideshowTarget),
          videoTarget: toInt(raw?.videoTarget),
        }),
      );
    }
    if (rows.length === 0) {
      throw new BadRequestException('No valid target rows (missing publication)');
    }
    await this.targetRepo.save(rows);
    this.logger.log(`Updated ${rows.length} report targets.`);
    return { updated: rows.length, targets: await this.getTargets() };
  }

  // ───────────────────────────── Ingest ─────────────────────────────

  async ingest(body: any): Promise<IngestResult> {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException('Body must be a JSON object');
    }
    const rows = body.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException('`rows` must be a non-empty array');
    }
    switch (body.reportType) {
      case 'eod':
        return this.ingestEod(body);
      case 'weekly':
      case 'eow':
        return this.ingestEow(body);
      case 'mtd':
        return this.ingestMtd(body);
      default:
        throw new BadRequestException(
          `Unknown reportType "${body.reportType}" (expected eod | weekly | mtd)`,
        );
    }
  }

  private async ingestEod(body: any): Promise<IngestResult> {
    const date = toIsoDate(body.date);
    if (!date) {
      throw new BadRequestException(`Unparseable EOD date "${body.date}"`);
    }

    const skipped: string[] = [];
    let written = 0;

    for (const raw of body.rows as EodRow[]) {
      const publication = String(raw?.publication ?? '').trim();
      if (!publication) {
        skipped.push('(missing publication)');
        continue;
      }

      const stored = await this.eodRepo.findOne({
        where: { date, publication },
      });

      const merged = this.eodRepo.create({
        date,
        publication,
        followers: numToCol(mergeNum(raw.followers, stored?.followers)),
        feedHealthRate: mergeNum(raw.feedHealthRate, stored?.feedHealthRate),
        publishRate: mergeNum(raw.publishRate, stored?.publishRate),
        publishedVideo: mergeNum(raw.published?.video, stored?.publishedVideo),
        publishedGallery: mergeNum(
          raw.published?.gallery,
          stored?.publishedGallery,
        ),
        publishedArticle: mergeNum(
          raw.published?.article,
          stored?.publishedArticle,
        ),
        publishedTotal: mergeNum(raw.published?.total, stored?.publishedTotal),
        views: this.mergeViews(raw.views, stored?.views),
        feedList: this.mergeFeedList(raw.feedList, stored?.feedList),
      });

      await this.eodRepo.save(merged);
      written++;
    }

    this.logger.log(
      `EOD ingest ${date}: ${written} rows written, ${skipped.length} skipped`,
    );
    return {
      reportType: 'eod',
      periodKey: date,
      received: body.rows.length,
      written,
      skipped,
    };
  }

  /** Per-type, per-region non-zero merge of the EOD views grid. */
  private mergeViews(
    incoming: EodRow['views'],
    stored: Record<string, Record<string, number>> | undefined,
  ): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    const types = new Set([
      ...Object.keys(stored ?? {}),
      ...Object.keys(incoming ?? {}),
    ]);
    for (const type of types) {
      out[type] = {};
      const regions = new Set([
        ...Object.keys(stored?.[type] ?? {}),
        ...Object.keys(incoming?.[type] ?? {}),
      ]);
      for (const region of regions) {
        const v = mergeNum(incoming?.[type]?.[region], stored?.[type]?.[region]);
        if (v !== null) out[type][region] = v;
      }
    }
    return out;
  }

  /** Feed-list rows merged by (region, type); text fields non-blank-wins. */
  private mergeFeedList(
    incoming: EodRow['feedList'],
    stored: MsnReportEod['feedList'] | undefined,
  ): MsnReportEod['feedList'] {
    const byKey = new Map<string, MsnReportEod['feedList'][number]>();
    for (const row of stored ?? []) {
      byKey.set(`${row.region}|${row.type}`, { ...row });
    }
    for (const raw of incoming ?? []) {
      const region = String(raw?.region ?? '').trim();
      const type = String(raw?.type ?? '').trim();
      if (!region && !type) continue;
      const key = `${region}|${type}`;
      const prev = byKey.get(key);
      byKey.set(key, {
        region,
        type,
        reliability: mergeText(raw.reliability, prev?.reliability),
        publishRate: mergeText(raw.publishRate, prev?.publishRate),
      });
    }
    return [...byKey.values()];
  }

  private async ingestEow(body: any): Promise<IngestResult> {
    const weekStart = toIsoDate(body.weekStart);
    const weekEnd = toIsoDate(body.weekEnd) ?? toIsoDate(body.date);
    if (!weekStart || !weekEnd) {
      throw new BadRequestException(
        `Unparseable weekly window "${body.weekStart}" → "${body.weekEnd}"`,
      );
    }

    const skipped: string[] = [];
    let written = 0;

    for (const raw of body.rows as WeeklyRow[]) {
      const publication = String(raw?.publication ?? '').trim();
      if (!publication) {
        skipped.push('(missing publication)');
        continue;
      }

      const stored = await this.eowRepo.findOne({
        where: { weekStart, publication },
      });

      const merged = this.eowRepo.create({
        weekStart,
        publication,
        weekEnd,
        articlePublished: mergeNum(raw.articlePublished, stored?.articlePublished),
        articleViews: numToCol(mergeNum(raw.articleViews, stored?.articleViews)),
        slideshowPublished: mergeNum(
          raw.slideshowPublished,
          stored?.slideshowPublished,
        ),
        slideshowViews: numToCol(
          mergeNum(raw.slideshowViews, stored?.slideshowViews),
        ),
        videoPublished: mergeNum(raw.videoPublished, stored?.videoPublished),
        videoViews: numToCol(mergeNum(raw.videoViews, stored?.videoViews)),
        videoConsumedHours: mergeNum(
          raw.videoConsumedHours,
          stored?.videoConsumedHours,
        ),
      });

      await this.eowRepo.save(merged);
      written++;
    }

    this.logger.log(
      `EOW ingest ${weekStart}→${weekEnd}: ${written} rows written, ${skipped.length} skipped`,
    );
    return {
      reportType: 'weekly',
      periodKey: weekStart,
      received: body.rows.length,
      written,
      skipped,
    };
  }

  private async ingestMtd(body: any): Promise<IngestResult> {
    // Month key = first day of the month, derived from monthStart or asOf/date.
    const monthStart =
      toIsoDate(body.monthStart) ?? toIsoDate(body.asOf) ?? toIsoDate(body.date);
    if (!monthStart) {
      throw new BadRequestException(
        `Unparseable MTD month "${body.monthStart ?? body.month}"`,
      );
    }
    const month = `${monthStart.slice(0, 7)}-01`;
    const asOf = toIsoDate(body.asOf) ?? toIsoDate(body.date);

    const skipped: string[] = [];
    let written = 0;

    for (const raw of body.rows as MtdRow[]) {
      const publication = String(raw?.publication ?? '').trim();
      if (!publication) {
        skipped.push('(missing publication)');
        continue;
      }

      const stored = await this.mtdRepo.findOne({
        where: { month, publication },
      });

      // asOf advances to the latest window end we have seen for the month.
      const nextAsOf =
        asOf && (!stored?.asOf || asOf > stored.asOf) ? asOf : (stored?.asOf ?? asOf);

      const merged = this.mtdRepo.create({
        month,
        publication,
        asOf: nextAsOf,
        articleViews: numToCol(mergeNum(raw.articleViews, stored?.articleViews)),
        slideshowViews: numToCol(
          mergeNum(raw.slideshowViews, stored?.slideshowViews),
        ),
        videoViews: numToCol(mergeNum(raw.videoViews, stored?.videoViews)),
        videoConsumedHours: mergeNum(
          raw.videoConsumedHours,
          stored?.videoConsumedHours,
        ),
      });

      await this.mtdRepo.save(merged);
      written++;
    }

    this.logger.log(
      `MTD ingest ${month} (asOf ${asOf}): ${written} rows written, ${skipped.length} skipped`,
    );
    return {
      reportType: 'mtd',
      periodKey: month,
      received: body.rows.length,
      written,
      skipped,
    };
  }

  // ───────────────────────────── Query ─────────────────────────────

  /** Available periods for each report, newest first (for UI selectors). */
  async getPeriods(): Promise<{
    eod: string[];
    eow: Array<{ weekStart: string; weekEnd: string }>;
    mtd: Array<{ month: string; asOf: string | null }>;
  }> {
    const [eodRows, eowRows, mtdRows] = await Promise.all([
      this.eodRepo
        .createQueryBuilder('r')
        .select('r.date', 'date')
        .distinct(true)
        .orderBy('r.date', 'DESC')
        .getRawMany(),
      this.eowRepo
        .createQueryBuilder('r')
        .select('r.weekStart', 'weekStart')
        .addSelect('MAX(r.weekEnd)', 'weekEnd')
        .groupBy('r.weekStart')
        .orderBy('r.weekStart', 'DESC')
        .getRawMany(),
      this.mtdRepo
        .createQueryBuilder('r')
        .select('r.month', 'month')
        .addSelect('MAX(r.asOf)', 'asOf')
        .groupBy('r.month')
        .orderBy('r.month', 'DESC')
        .getRawMany(),
    ]);

    return {
      eod: eodRows.map((r) => dateCol(r.date)),
      eow: eowRows.map((r) => ({
        weekStart: dateCol(r.weekStart),
        weekEnd: dateCol(r.weekEnd),
      })),
      mtd: mtdRows.map((r) => ({
        month: dateCol(r.month),
        asOf: r.asOf ? dateCol(r.asOf) : null,
      })),
    };
  }

  async getEod(date?: string) {
    const key = date ?? (await this.latestKey(this.eodRepo, 'date'));
    if (!key) throw new NotFoundException('No EOD reports ingested yet');
    const rows = await this.eodRepo.find({
      where: { date: key },
      order: { publication: 'ASC' },
    });
    return {
      date: key,
      rows: rows.map((r) => ({
        ...r,
        date: dateCol(r.date),
        followers: toNum(r.followers),
      })),
    };
  }

  async getEow(weekStart?: string) {
    const key = weekStart ?? (await this.latestKey(this.eowRepo, 'weekStart'));
    if (!key) throw new NotFoundException('No weekly reports ingested yet');
    const rows = await this.eowRepo.find({
      where: { weekStart: key },
      order: { publication: 'ASC' },
    });
    return {
      weekStart: key,
      weekEnd: rows.length ? dateCol(rows[0].weekEnd) : null,
      rows: rows.map((r) => ({
        ...r,
        weekStart: dateCol(r.weekStart),
        weekEnd: dateCol(r.weekEnd),
        articleViews: toNum(r.articleViews),
        slideshowViews: toNum(r.slideshowViews),
        videoViews: toNum(r.videoViews),
      })),
    };
  }

  async getMtd(month?: string) {
    // Accept both "2026-06" and "2026-06-01".
    const key = month
      ? `${month.slice(0, 7)}-01`
      : await this.latestKey(this.mtdRepo, 'month');
    if (!key) throw new NotFoundException('No MTD reports ingested yet');
    const rows = await this.mtdRepo.find({
      where: { month: key },
      order: { publication: 'ASC' },
    });
    return {
      month: key,
      asOf: rows.length && rows[0].asOf ? dateCol(rows[0].asOf) : null,
      rows: rows.map((r) => ({
        ...r,
        month: dateCol(r.month),
        asOf: r.asOf ? dateCol(r.asOf) : null,
        articleViews: toNum(r.articleViews),
        slideshowViews: toNum(r.slideshowViews),
        videoViews: toNum(r.videoViews),
      })),
    };
  }

  private async latestKey(
    repo: Repository<any>,
    column: string,
  ): Promise<string | null> {
    const row = await repo
      .createQueryBuilder('r')
      .select(`MAX(r.${column})`, 'latest')
      .getRawOne();
    return row?.latest ? dateCol(row.latest) : null;
  }
}

/** number | null → what a pg bigint column expects (string | null). */
function numToCol(n: number | null): string | null {
  return n === null ? null : String(n);
}

/** pg `date` columns come back as Date or string depending on driver config. */
function dateCol(v: unknown): string {
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}
