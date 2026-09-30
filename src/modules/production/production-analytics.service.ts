import { Logger } from '@nestjs/common';
import { ProductionPiece, RosterPerson, StageApi } from './production-piece';
import { NameResolver, buildNameResolver } from './name-resolver';
import { istParts, shiftDate, todayIst, weekdayNameOf } from './time';
import {
  AGE_BANDS,
  TAT_BANDS,
  WEEKDAYS,
  activeDayCount,
  band,
  hoursBetween,
  mean,
  meanOrNull,
  median,
  medianOrNull,
  pct,
  percentile,
  percentileOrNull,
  perDay,
  round,
} from './analytics';
import {
  AllotterStats,
  ArticleTypeEntry,
  DivisionStats,
  EditorStats,
  FilterOptions,
  FunnelStage,
  InsightsResult,
  KpiDelta,
  KpiOverview,
  PendingItem,
  PendingResult,
  ProductionFilterParams,
  RosterResult,
  SendBackResult,
  TatResult,
  TatStat,
  TimeseriesBucket,
  WriterStats,
} from './types';

export type { NameResolver } from './name-resolver';

/**
 * Every analytic the production dashboards serve, over any pipeline whose rows
 * satisfy {@link ProductionPiece}.
 *
 * Critical Flow and Yahoo are the same lifecycle recorded in different sheets,
 * so the arithmetic below is identical for both; forking it would guarantee
 * the two pages drift apart the first time either is fixed. What genuinely
 * differs is supplied by the subclass: where rows come from, and what counts
 * as "sent back" — Yahoo has a single editorial pass and no send-back loop, so
 * its StageApi reports none and those surfaces collapse to zero on their own.
 */
export abstract class ProductionAnalyticsService<P extends ProductionPiece> {
  protected readonly logger = new Logger(this.constructor.name);

  /** Lifecycle predicates for this pipeline. */
  protected abstract readonly st: StageApi<P>;

  /** Every piece held for this pipeline. */
  protected abstract loadPieces(): Promise<P[]>;

  /** The rostered people, or [] where the pipeline tracks no roster. */
  protected abstract loadRoster(): Promise<RosterPerson[]>;

  // ── Stage predicates ──
  //
  // A division may skip filling in "Submitted At" entirely and still run the
  // piece through editorial, so submission is inferred from any later evidence
  // rather than trusted as a lone column.

  protected reachedEditorial(p: P): boolean {
    return this.st.reachedEditorial(p);
  }

  protected isSubmitted(p: P): boolean {
    return this.st.isSubmitted(p);
  }

  protected isVerified(p: P): boolean {
    return this.st.isVerified(p);
  }

  /** Went back to the writer at least once. */
  protected isSentBack(p: P): boolean {
    return this.st.isSentBack(p);
  }

  /** Sent back and not yet cleared by a later pass. */
  protected isOpenSendBack(p: P): boolean {
    return this.st.isOpenSendBack(p);
  }

  protected isPublished(p: P): boolean {
    return this.st.isPublished(p);
  }

  protected isKilled(p: P): boolean {
    return this.st.isKilled(p);
  }

  protected isOnHold(p: P): boolean {
    return this.st.isOnHold(p);
  }

  /** Effective turnaround: the sheet's own TAT, else allotment → publication. */
  protected tat(p: P): number | null {
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
  protected hasAllotmentTime(p: P): boolean {
    if (!p.allottedAt) return false;
    const { hour, minute } = istParts(new Date(p.allottedAt));
    return hour !== 0 || minute !== 0;
  }

  /** Hours from allotment to submission, or null when allotment has no clock time. */
  protected writeHours(p: P): number | null {
    if (!this.hasAllotmentTime(p)) return null;
    return hoursBetween(p.allottedAt, p.submittedAt);
  }

  /**
   * Which queue a piece is sitting in, or null when it is finished, killed or
   * so old that calling it "pending" would be misleading.
   */
  protected pendingStage(p: P, now: Date): string | null {
    return this.st.pendingStage(p, now);
  }

  protected pendingAnchor(p: P, stage: string): Date | null {
    return this.st.pendingAnchor(p, stage);
  }

  protected pendingWith(p: P, stage: string): string {
    if (stage === 'Awaiting Submission' || stage === 'Sent Back') return p.writer;
    return p.editor !== 'Unknown' ? p.editor : 'Unassigned';
  }

  protected toPendingItem(p: P, stage: string, now: Date): PendingItem {
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

  protected async load(): Promise<P[]> {
    return this.loadPieces();
  }

  protected async filter(params: ProductionFilterParams): Promise<P[]> {
    const rows = await this.load();
    const inSet = (v: string, list?: string[]) => !list?.length || list.includes(v);

    // The filter dropdowns offer resolved names ("Caroline"), while rows carry
    // whatever the sheet typed ("Caroline John"). Matching the raw spelling
    // returned nothing, or a fraction, for any person the resolver renames.
    const byPerson = !!(params.writers?.length || params.editors?.length || params.allotters?.length);
    const resolve = byPerson ? await this.nameResolver() : null;
    const personIn = (raw: string, division: string, list?: string[]) =>
      !list?.length || list.includes(resolve ? resolve(raw, division) : raw);

    return rows.filter((p) => {
      if (params.startDate && (!p.date || p.date < params.startDate)) return false;
      if (params.endDate && (!p.date || p.date > params.endDate)) return false;
      if (!inSet(p.division, params.divisions)) return false;
      if (!personIn(p.writer, p.division, params.writers)) return false;
      if (!personIn(p.editor, p.division, params.editors)) return false;
      if (!inSet(p.articleType, params.articleTypes)) return false;
      if (!inSet(p.editorialStatus, params.statuses)) return false;
      if (!personIn(p.allottedBy, p.division, params.allotters)) return false;
      return true;
    });
  }

  /** Same-length window immediately before the requested one, for deltas. */
  protected previousPeriod(params: ProductionFilterParams): ProductionFilterParams {
    if (!params.startDate || !params.endDate) return { ...params };
    const days = Math.max(
      1,
      Math.round((Date.parse(params.endDate) - Date.parse(params.startDate)) / 86400000) + 1,
    );
    return {
      ...params,
      startDate: shiftDate(params.startDate, -days),
      endDate: shiftDate(params.startDate, -1),
    };
  }

  protected delta(cur: number, prev: number): KpiDelta {
    return {
      value: round(cur - prev),
      pct: prev > 0 ? round(((cur - prev) / prev) * 100) : null,
    };
  }

  // ── Name canonicalisation ──
  //
  // Every per-person aggregation MUST go through this resolver — a table that
  // skips it will silently disagree with the headline numbers.

  async nameResolver(): Promise<NameResolver> {
    const [roster, pieces] = await Promise.all([this.loadRoster(), this.load()]);
    return buildNameResolver(roster, pieces);
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

  async getOverview(params: ProductionFilterParams): Promise<KpiOverview> {
    const resolve = await this.nameResolver();
    const rows = await this.filter(params);
    const cur = this.computeKpis(rows, resolve, params);

    const KEYS = [
      'allotted', 'submitted', 'verified', 'published', 'publishRate',
      'submissionRate', 'sendBackRate', 'medianTatHours', 'avgTatHours',
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

    const prevParams = this.previousPeriod(params);
    const prev = this.computeKpis(await this.filter(prevParams), resolve, prevParams);
    for (const key of KEYS) {
      deltas[key] = this.delta(cur[key] as number, prev[key] as number);
    }
    return { ...cur, deltasAvailable: true, deltas };
  }

  protected computeKpis(
    rows: P[],
    resolve: NameResolver,
    range: Pick<ProductionFilterParams, 'startDate' | 'endDate'> = {},
  ): Omit<KpiOverview, 'deltas' | 'deltasAvailable'> {
    const now = new Date();
    const allotted = rows.length;
    const submitted = rows.filter((p) => this.isSubmitted(p)).length;
    const verified = rows.filter((p) => this.isVerified(p)).length;
    const published = rows.filter((p) => this.isPublished(p)).length;
    const reachedEd = rows.filter((p) => this.reachedEditorial(p));
    const sentBack = rows.filter((p) => this.isSentBack(p)).length;

    const tats = rows.map((p) => this.tat(p)).filter((n): n is number => n != null);

    const pendingCount = rows.filter((p) => this.pendingStage(p, now) !== null).length;

    const writers = new Set(
      rows.filter((p) => p.writer !== 'Unknown').map((p) => resolve(p.writer, p.division)),
    );
    const editors = new Set(
      rows.filter((p) => p.editor !== 'Unknown').map((p) => resolve(p.editor, p.division)),
    );

    // Per writer per day *worked*: each writer's submissions over the days they
    // actually submitted, the same count the Writers table shows. Dividing by
    // the days in the range would charge a writer who worked 5 of 7 days for 7.
    const byWriter = new Map<string, P[]>();
    for (const p of rows) {
      if (p.writer === 'Unknown' || !this.isSubmitted(p)) continue;
      const name = resolve(p.writer, p.division);
      if (!byWriter.has(name)) byWriter.set(name, []);
      byWriter.get(name)!.push(p);
    }
    let writerDaysWorked = 0;
    let writerSubmitted = 0;
    for (const rs of byWriter.values()) {
      writerSubmitted += rs.length;
      writerDaysWorked += activeDayCount(rs, (p) => p.submittedAt, {
        fallback: (p) => p.date,
        startDate: range.startDate,
        endDate: range.endDate,
      });
    }

    return {
      allotted,
      submitted,
      verified,
      published,
      publishRate: pct(published, allotted),
      submissionRate: pct(submitted, allotted),
      sendBackRate: pct(sentBack, reachedEd.length),
      medianTatHours: median(tats),
      avgTatHours: mean(tats),
      p90TatHours: percentile(tats, 90),
      pendingCount,
      activeWriters: writers.size,
      activeEditors: editors.size,
      perWriterPerDay: perDay(writerSubmitted, writerDaysWorked),
      writerDaysWorked,
    };
  }

  async getTimeseries(
    params: ProductionFilterParams,
    granularity = 'day',
  ): Promise<TimeseriesBucket[]> {
    const rows = await this.filter(params);
    const key = (d: string): string => {
      if (granularity === 'month') return d.slice(0, 7);
      if (granularity === 'week') {
        // Weeks start on Sunday, computed on the date string itself so the
        // server's zone cannot move a day into the neighbouring week.
        return shiftDate(d, -new Date(`${d}T12:00:00Z`).getUTCDay());
      }
      return d;
    };

    const buckets = new Map<string, { rows: P[] }>();
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
          medianTatHours: median(tats),
          avgTatHours: mean(tats),
        };
      });
  }

  async getFunnel(params: ProductionFilterParams): Promise<FunnelStage[]> {
    const rows = await this.filter(params);

    // Counted as "reached at least this far", so a later stage implies every
    // earlier one. Without that, pieces the source published while leaving the
    // editorial status blank make Published exceed Verified and the funnel
    // reports a conversion above 100%.
    const published = (p: P) => this.isPublished(p);
    const verified = (p: P) => this.isVerified(p) || published(p);
    const editorial = (p: P) => this.reachedEditorial(p) || verified(p);
    const submitted = (p: P) => this.isSubmitted(p) || editorial(p);

    const steps: [string, number][] = [
      ['Allotted', rows.length],
      ['Submitted', rows.filter(submitted).length],
      ['Reached Editorial', rows.filter(editorial).length],
      ['Verified', rows.filter(verified).length],
      ['Published', rows.filter(published).length],
    ];
    return steps.map(([stage, count], i) => {
      const prev = i === 0 ? count : steps[i - 1][1];
      return {
        stage,
        count,
        conversion: pct(count, prev),
        dropped: Math.max(0, prev - count),
      };
    });
  }

  async getPending(params: ProductionFilterParams): Promise<PendingResult> {
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

  async getWriterStats(params: ProductionFilterParams): Promise<WriterStats[]> {
    const rows = await this.filter(params);
    const resolve = await this.nameResolver();
    const now = new Date();

    const map = new Map<string, { division: Map<string, number>; rows: P[] }>();
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
        // Anchored on the submission stamp, falling back to the piece's own
        // date where a division never fills that column in.
        const writerDays = activeDayCount(
          rs.filter((p) => this.isSubmitted(p)),
          (p) => p.submittedAt,
          { fallback: (p) => p.date, startDate: params.startDate, endDate: params.endDate },
        );
        return {
          writer,
          division: [...division.entries()].sort((a, b) => b[1] - a[1])[0][0],
          allotted: rs.length,
          submitted,
          verified: rs.filter((p) => this.isVerified(p)).length,
          published: rs.filter((p) => this.isPublished(p)).length,
          sentBack,
          sendBackRate: pct(sentBack, submitted),
          medianTatHours: median(tats),
          avgTatHours: mean(tats),
          medianWriteHours: medianOrNull(writeTimes),
          submissionRate: pct(submitted, rs.length),
          pending: rs.filter((p) => this.pendingStage(p, now) !== null).length,
          activeDays: writerDays,
          perActiveDay: perDay(submitted, writerDays),
        };
      })
      .sort((a, b) => b.allotted - a.allotted);
  }

  async getEditorStats(params: ProductionFilterParams): Promise<EditorStats[]> {
    const rows = await this.filter(params);
    const resolve = await this.nameResolver();

    const map = new Map<string, { division: Map<string, number>; rows: P[] }>();
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
        const editorDays = activeDayCount(rs, (p) => p.editorAt, {
          fallback: (p) => p.date,
          startDate: params.startDate,
          endDate: params.endDate,
        });
        return {
          editor,
          division: [...division.entries()].sort((a, b) => b[1] - a[1])[0][0],
          handled: rs.length,
          verified: rs.filter((p) => this.isVerified(p)).length,
          sentBack,
          sendBackRate: pct(sentBack, rs.length),
          secondPass: rs.filter((p) => !!p.editorAt2).length,
          medianReviewHours: medianOrNull(reviews),
          avgReviewHours: meanOrNull(reviews),
          activeDays: editorDays,
          perActiveDay: perDay(rs.length, editorDays),
        };
      })
      .sort((a, b) => b.handled - a.handled);
  }

  async getAllotterStats(params: ProductionFilterParams): Promise<AllotterStats[]> {
    const rows = await this.filter(params);
    const resolve = await this.nameResolver();

    const map = new Map<string, { division: Map<string, number>; rows: P[] }>();
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

  async getSendBacks(params: ProductionFilterParams): Promise<SendBackResult> {
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
      keyOf: (p: P) => string,
      pool: P[],
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

  async getTat(params: ProductionFilterParams): Promise<TatResult> {
    const rows = await this.filter(params);
    const resolve = await this.nameResolver();

    const withTat = rows
      .map((p) => ({ p, t: this.tat(p) }))
      .filter((x): x is { p: P; t: number } => x.t != null);
    const all = withTat.map((x) => x.t);

    const stat = (label: string, vals: number[]): TatStat => ({
      label,
      count: vals.length,
      median: median(vals),
      avg: mean(vals),
      p90: percentile(vals, 90),
      max: vals.length ? round(Math.max(...vals)) : 0,
    });

    const groupStat = (keyOf: (p: P) => string, minCount = 1): TatStat[] => {
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

    const legs: [string, (p: P) => number | null][] = [
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
          avg: meanOrNull(vals),
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

  async getDivisions(params: ProductionFilterParams): Promise<DivisionStats[]> {
    const rows = await this.filter(params);
    const resolve = await this.nameResolver();
    const now = new Date();

    const m = new Map<string, P[]>();
    for (const p of rows) {
      if (!m.has(p.division)) m.set(p.division, []);
      m.get(p.division)!.push(p);
    }

    return [...m.entries()]
      .map(([division, rs]) => {
        const tats = rs.map((p) => this.tat(p)).filter((n): n is number => n != null);
        const published = rs.filter((p) => this.isPublished(p)).length;
        return {
          division,
          allotted: rs.length,
          submitted: rs.filter((p) => this.isSubmitted(p)).length,
          verified: rs.filter((p) => this.isVerified(p)).length,
          published,
          sentBack: rs.filter((p) => this.isSentBack(p)).length,
          pending: rs.filter((p) => this.pendingStage(p, now) !== null).length,
          publishRate: pct(published, rs.length),
          medianTatHours: median(tats),
          avgTatHours: mean(tats),
          writers: new Set(rs.filter((p) => p.writer !== 'Unknown').map((p) => resolve(p.writer, p.division))).size,
          editors: new Set(rs.filter((p) => p.editor !== 'Unknown').map((p) => resolve(p.editor, p.division))).size,
        };
      })
      .sort((a, b) => b.allotted - a.allotted);
  }

  async getArticleTypes(params: ProductionFilterParams): Promise<ArticleTypeEntry[]> {
    const rows = await this.filter(params);
    const m = new Map<string, P[]>();
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
          avgTatHours: mean(tats),
        };
      })
      .sort((a, b) => b.count - a.count);
  }

  async getRoster(params: ProductionFilterParams): Promise<RosterResult> {
    const [roster, rows] = await Promise.all([this.loadRoster(), this.filter(params)]);
    const resolve = await this.nameResolver();
    const now = new Date();
    const todayName = weekdayNameOf(todayIst(now));

    // Activity index, keyed on the resolved identity so roster and data agree.
    const activity = new Map<string, { active: number; last: string | null; count: number; division: string }>();
    const touch = (raw: string, division: string, p: P) => {
      if (!raw || raw === 'Unknown') return;
      const name = resolve(raw, division);
      if (!activity.has(name)) activity.set(name, { active: 0, last: null, count: 0, division });
      const a = activity.get(name)!;
      a.count++;
      if (this.pendingStage(p, now) !== null) a.active++;
      if (p.date && (!a.last || p.date > a.last)) a.last = p.date;
    };
    // Who turned up writing or editing, as opposed to only allotting.
    const workers = new Set<string>();
    for (const p of rows) {
      touch(p.writer, p.division, p);
      touch(p.editor, p.division, p);
      touch(p.allottedBy, p.division, p);
      for (const raw of [p.writer, p.editor]) {
        if (raw && raw !== 'Unknown') workers.add(resolve(raw, p.division));
      }
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

    // Writers and editors doing the work who are not on the schedule — usually
    // a list that has fallen behind, occasionally a name spelt a new way. The
    // schedule does not list allotters and group heads, so someone who only
    // allots is not a gap.
    const rosterNames = new Set(people.map((p) => p.name.toLowerCase()));
    const unrostered = [...activity.entries()]
      .filter(([name]) => workers.has(name))
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

  async getInsights(params: ProductionFilterParams): Promise<InsightsResult> {
    const rows = await this.filter(params);
    const resolve = await this.nameResolver();
    const now = new Date();

    // Weekday rhythm, anchored on the allotment day.
    const wd = new Map<number, P[]>();
    for (const p of rows) {
      if (!p.date) continue;
      const d = new Date(`${p.date}T12:00:00Z`).getUTCDay();
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
        avgTatHours: mean(tats),
      };
    });

    const heat = new Map<string, number>();
    for (const p of rows) {
      if (!p.submittedAt) continue;
      const { weekday, hour } = istParts(new Date(p.submittedAt));
      const k = `${weekday}-${hour}`;
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

    const dupMap = new Map<string, P[]>();
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
