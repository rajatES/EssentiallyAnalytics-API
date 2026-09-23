import { BadRequestException, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CfPiece } from '../critical-flow/entities/cf-piece.entity';
import { YpPiece } from '../yahoo-production/entities/yp-piece.entity';
import { YpDivisionQuota } from '../yahoo-production/entities/yp-division-quota.entity';
import { NameResolver, buildNameResolver } from '../production/name-resolver';
import { ResPerson } from './entities/res-person.entity';
import { ResLeave } from './entities/res-leave.entity';
import { ResDivisionQuota } from './entities/res-division-quota.entity';
import { ResProfile } from './entities/res-profile.entity';
import { ResourcesSyncService } from './resources-sync.service';
import { FLOAT_POOLS, canonicalDivision, parseDivisions } from './divisions';
import { WorkItem, buildWorkItems, namedPieces } from './work-items';
import {
  DivisionResourceSummary,
  ResourceBoardResult,
  ResourceLeave,
  ResourcePerson,
  ResourceProfile,
  ResourceStatus,
  ResourceSummaryResult,
  ScheduleHealthFlag,
  ScheduleHealthResult,
  SuggestCandidate,
  SuggestResult,
} from './types';
import {
  currentShift,
  dateWithin,
  opsDayOf,
  shiftOf,
  todayIst,
  weekdayNameOf,
  Shift,
} from './time';

/** Editors with more than this many pieces waiting are "Busy". */
const EDITOR_BUSY_QUEUE = 4;
/** Writers with no quota set: this much in flight is "Available", more is "Busy". */
const WRITER_AVAILABLE_INFLIGHT = 2;
/** Content-only names need at least this many pieces to be listed as a resource. */
const UNLISTED_MIN_PIECES = 2;

interface Ctx {
  date: string;
  weekday: string;
  now: Date;
  shift: Shift;
  items: WorkItem[];
  resolve: NameResolver;
  /** lower-cased resolved writer name → their work (all divisions, both sheets) */
  byWriter: Map<string, WorkItem[]>;
  byEditor: Map<string, WorkItem[]>;
  /** lower-cased resolved name → division → piece count */
  worked: Map<string, Map<string, number>>;
  leavesFor: (name: string) => ResLeave[];
  profileFor: (division: string, name: string) => ResProfile | undefined;
  /** Every person's key on the board — a profile under one of these is not up for adoption. */
  ownedKeys: Set<string>;
  quotas: ResDivisionQuota[];
  /** board division → Yahoo's daily quota for it */
  yahooQuota: Map<string, number>;
  people: ResourcePerson[];
}

function lower(s: string): string {
  return s.toLowerCase();
}

function firstToken(s: string): string {
  return lower(s).split(/[\s.]+/)[0] || '';
}

function addTo<K>(m: Map<K, WorkItem[]>, k: K, w: WorkItem) {
  const arr = m.get(k);
  if (arr) arr.push(w);
  else m.set(k, [w]);
}

/** The desk day a submission counts toward, with the editorial stamp
 *  standing in where a division never fills the submission column. */
function submissionDay(w: WorkItem): string | null {
  const stamp = w.submittedAt || w.editorAt;
  return stamp ? opsDayOf(new Date(stamp)) : null;
}

function submissionShift(w: WorkItem): Shift | null {
  const stamp = w.submittedAt || w.editorAt;
  return stamp ? shiftOf(new Date(stamp)) : null;
}

/** A person as the sheets describe them, before today's numbers are added. */
interface PersonBase {
  key: string; name: string; primaryDivision: string; subFeed: string;
  secondaryDivisions: string[]; role: string; roleGroup: string; pod: string;
  shift: string; shiftClock: string; weekoff: string; backup: string;
  weekPlan: Record<string, any>; sources: string[]; flags: string[]; employment: string;
}

const onCfSheet = (w: WorkItem) => w.source !== 'yahoo';
const onYahooSheet = (w: WorkItem) => w.source !== 'cf';

/**
 * Who can take work now, and who covers whom. People come from the managers'
 * Dynamic Schedule (synced by {@link ResourcesSyncService}); load and output
 * are counted over Critical Flow and Yahoo together, because the same writers
 * and editors work both.
 */
@Injectable()
export class ResourcesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ResourcesService.name);

  constructor(
    private readonly sync: ResourcesSyncService,
    @InjectRepository(CfPiece) private readonly cfRepo: Repository<CfPiece>,
    @InjectRepository(YpPiece) private readonly ypRepo: Repository<YpPiece>,
    @InjectRepository(YpDivisionQuota) private readonly ypQuotaRepo: Repository<YpDivisionQuota>,
    @InjectRepository(ResPerson) private readonly peopleRepo: Repository<ResPerson>,
    @InjectRepository(ResLeave) private readonly leaveRepo: Repository<ResLeave>,
    @InjectRepository(ResDivisionQuota) private readonly quotaRepo: Repository<ResDivisionQuota>,
    @InjectRepository(ResProfile) private readonly profileRepo: Repository<ResProfile>,
  ) {}

  onApplicationBootstrap() {
    this.sync.firstSync
      .then(() => this.carryOverRosterTargets())
      .catch((e) => this.logger.error(`Carrying over roster targets failed: ${e.message}`));
  }

  // ── Context ──

  private async buildContext(dateParam?: string): Promise<Ctx> {
    const now = new Date();
    const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : todayIst(now);
    const [cf, yp, sched, leaves, quotas, profiles, ypQuotas] = await Promise.all([
      this.cfRepo.find(),
      this.ypRepo.find(),
      this.peopleRepo.find(),
      this.leaveRepo.find(),
      this.quotaRepo.find(),
      this.profileRepo.find(),
      this.ypQuotaRepo.find(),
    ]);

    const items = buildWorkItems(cf, yp, now);
    const resolve = buildNameResolver(
      sched.flatMap((s) => [
        { division: s.primaryDivision, name: s.name, floats: FLOAT_POOLS.has(s.primaryDivision) },
        ...(s.secondaryDivisions || []).map((d) => ({ division: d, name: s.name })),
      ]),
      namedPieces(items),
    );

    const byWriter = new Map<string, WorkItem[]>();
    const byEditor = new Map<string, WorkItem[]>();
    const worked = new Map<string, Map<string, number>>();
    const touch = (name: string, w: WorkItem, m: Map<string, WorkItem[]>) => {
      if (!name || name === 'Unknown') return;
      const key = lower(resolve(name, w.division));
      addTo(m, key, w);
      if (!worked.has(key)) worked.set(key, new Map());
      const c = worked.get(key)!;
      c.set(w.division, (c.get(w.division) ?? 0) + 1);
    };
    for (const w of items) {
      touch(w.writer, w, byWriter);
      for (const e of w.editors) touch(e, w, byEditor);
    }

    // The leave form takes whatever name the person typed — "Rati" for "Rati
    // Agrawal". A one-word leave name attaches to the only person with that
    // first name; if two people share it, it attaches to neither.
    const firstCount = new Map<string, number>();
    for (const s of sched) firstCount.set(firstToken(s.name), (firstCount.get(firstToken(s.name)) ?? 0) + 1);
    const leavesFor = (name: string): ResLeave[] => {
      const l = lower(name);
      const f = firstToken(name);
      return leaves.filter((x) => {
        const xl = lower(x.name);
        if (xl === l) return true;
        return !xl.includes(' ') && xl === f && firstCount.get(f) === 1;
      });
    };

    // Profiles are keyed `${division}|${name}` with the name as the schedule
    // spelt it when the quota was saved. When the spelling since grew ("Yeswanth"
    // → "Yeswanth Praveen"), the saved quota still belongs to them — but only a
    // profile nobody else answers to is adopted, or "Archana.R" would take
    // "Archana"'s quota as well and the one target would count twice.
    const profileByKey = new Map(profiles.map((p) => [p.id, p]));
    const ownedKeys = new Set<string>();
    const profileFor = (division: string, name: string): ResProfile | undefined => {
      const exact = profileByKey.get(`${division}|${name}`);
      if (exact) return exact;
      const want = lower(resolve(name, division));
      const same = profiles.filter((p) => p.division === division && !ownedKeys.has(p.id));
      return (
        same.find((p) => lower(resolve(p.name, division)) === want) ||
        same.find((p) => !p.name.includes(' ') && lower(p.name) === firstToken(name))
      );
    };

    const yahooQuota = new Map<string, number>();
    for (const q of ypQuotas) {
      if (q.quota == null) continue;
      const covered = new Set(
        (q.divisions?.length ? q.divisions : [q.division]).map((d) => canonicalDivision(d).division),
      );
      for (const d of covered) yahooQuota.set(d, (yahooQuota.get(d) ?? 0) + q.quota);
    }

    const ctx: Ctx = {
      date,
      weekday: weekdayNameOf(date),
      now,
      shift: currentShift(now),
      items,
      resolve,
      byWriter,
      byEditor,
      worked,
      leavesFor,
      profileFor,
      ownedKeys,
      quotas,
      yahooQuota,
      people: [],
    };
    ctx.people = this.buildPeople(ctx, sched);
    return ctx;
  }

  /**
   * The people universe: the managers' schedule, plus anyone doing work who is
   * not on it — so a writer nobody has added yet still shows up rather than
   * vanishing.
   */
  private buildPeople(ctx: Ctx, sched: ResPerson[]): ResourcePerson[] {
    const out = new Map<string, PersonBase>();
    const keyOf = (division: string, name: string) => `${division}|${name}`;

    // Identity for de-duplication is the division-resolved, lower-cased name;
    // the DISPLAY name is the schedule's spelling, not the resolver's pick,
    // which favours the commonest content spelling.
    const identity = (division: string, name: string) =>
      `${division}|${lower(ctx.resolve(name, division))}`;
    const seen = new Set<string>();
    const listedNames = new Set<string>();
    const note = (division: string, name: string) => {
      seen.add(identity(division, name));
      listedNames.add(lower(name));
      listedNames.add(lower(ctx.resolve(name, division)));
      // Whatever content keys this person will be credited with are theirs;
      // without this, "Gokul" in the content becomes a second, unlisted Gokul
      // next to the schedule's "Gokul Gopalakrishna Pillai".
      for (const k of this.contentKeys(ctx, ctx.byWriter, name, division)) listedNames.add(k);
      for (const k of this.contentKeys(ctx, ctx.byEditor, name, division)) listedNames.add(k);
    };

    for (const s of sched) {
      if (seen.has(identity(s.primaryDivision, s.name))) continue;
      note(s.primaryDivision, s.name);
      const key = keyOf(s.primaryDivision, s.name);
      out.set(key, {
        key,
        name: s.name,
        primaryDivision: s.primaryDivision,
        subFeed: s.subFeed,
        secondaryDivisions: s.secondaryDivisions || [],
        role: s.role,
        roleGroup: s.roleGroup,
        pod: s.pod,
        shift: s.shift,
        shiftClock: s.shiftClock,
        weekoff: s.weekoff,
        backup: s.backup,
        weekPlan: safeJson(s.weekPlan),
        sources: ['schedule'],
        flags: s.flags ? s.flags.split(',').filter(Boolean) : [],
        employment: s.status,
      });
    }

    // Content-only people: doing the work, not on the schedule.
    const contentSeen = new Set<string>();
    for (const [lname, divs] of ctx.worked) {
      if (listedNames.has(lname) || contentSeen.has(lname)) continue;
      contentSeen.add(lname);
      const total = [...divs.values()].reduce((a, b) => a + b, 0);
      if (total < UNLISTED_MIN_PIECES) continue;
      const primary = [...divs.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const asWriter = ctx.byWriter.get(lname)?.length ?? 0;
      const asEditor = ctx.byEditor.get(lname)?.length ?? 0;
      const sample = (ctx.byWriter.get(lname) || ctx.byEditor.get(lname) || [])[0];
      const raw = sample
        ? asWriter >= asEditor
          ? sample.writer
          : sample.editors.find((e) => lower(ctx.resolve(e, sample.division)) === lname) || lname
        : lname;
      const display = sample ? ctx.resolve(raw, sample.division) : lname;
      const key = keyOf(primary, display);
      out.set(key, {
        key, name: display,
        primaryDivision: primary,
        subFeed: '',
        secondaryDivisions: [],
        role: asWriter >= asEditor ? 'Writer' : 'Editor',
        roleGroup: asWriter >= asEditor ? 'writer' : 'editor',
        pod: '', shift: '', shiftClock: '', weekoff: '', backup: '',
        weekPlan: {},
        sources: ['content'],
        flags: ['unlisted'],
        employment: '',
      });
    }

    // Keys are settled before anyone's profile is looked up, so an old-spelling
    // profile is only adopted when no one on the board answers to it exactly.
    for (const k of out.keys()) ctx.ownedKeys.add(k);
    return [...out.values()].map((b) => this.materialise(ctx, b)).sort(
      (a, b) => a.primaryDivision.localeCompare(b.primaryDivision) || a.name.localeCompare(b.name),
    );
  }

  private materialise(ctx: Ctx, base: PersonBase): ResourcePerson {
    const asWriter = this.workFor(ctx, ctx.byWriter, base.name, base.primaryDivision);
    const asEditor = this.workFor(ctx, ctx.byEditor, base.name, base.primaryDivision);
    const isEditor = base.roleGroup === 'editor';
    const mine = isEditor ? asEditor : asWriter;

    // ── Off today? ──
    const onLeave = this.leaveOn(ctx, base.name);
    const plan = base.weekPlan[ctx.weekday];
    let offReason = '';
    let coveredBy = '';
    if (onLeave) {
      offReason = `On leave (${onLeave.type}) until ${onLeave.to}`;
      coveredBy = base.backup;
    } else if (plan?.off) {
      offReason = 'Scheduled off';
      coveredBy = plan.coverBy || base.backup;
    } else if (base.weekoff && lower(base.weekoff).includes(lower(ctx.weekday))) {
      offReason = 'Weekly off';
      coveredBy = base.backup;
    }
    if (/inactive|left|resigned|exited/i.test(base.employment)) {
      offReason = offReason || `Inactive (${base.employment})`;
    }
    const offToday = !!offReason;

    // ── Output today ──
    const done = isEditor
      ? asEditor.filter((w) => w.publishedDate === ctx.date && w.published)
      : asWriter.filter((w) => submissionDay(w) === ctx.date);
    const verifiedToday = isEditor
      ? asEditor.filter((w) => w.editorAt && opsDayOf(new Date(w.editorAt)) === ctx.date).length
      : 0;

    // ── Load ──
    let inFlight = 0;
    let queue = 0;
    let loadYahoo = 0;
    for (const w of mine) {
      const st = w.pending;
      if (!st) continue;
      const counts = isEditor
        ? st === 'Awaiting Editorial' || st === 'Awaiting Live'
        : st === 'Awaiting Submission' || st === 'Sent Back';
      if (!counts) continue;
      if (isEditor) queue++;
      else inFlight++;
      if (onYahooSheet(w)) loadYahoo++;
    }

    const profile = ctx.profileFor(base.primaryDivision, base.name);
    const quota = profile?.dailyQuota ?? null;
    const doneToday = done.length;
    const remaining = quota == null ? null : Math.max(quota - doneToday - inFlight, 0);

    const { status, statusReason } = this.statusFor({
      roleGroup: base.roleGroup, offToday, offReason, quota, doneToday, inFlight, queue, remaining,
    });

    const undated = mine.filter((w) => !w.date).length;
    let lastActive: string | null = null;
    for (const w of mine) if (w.date && (!lastActive || w.date > lastActive)) lastActive = w.date;

    const workedAgg = new Map<string, number>();
    for (const k of this.contentKeys(ctx, ctx.worked, base.name, base.primaryDivision)) {
      for (const [d, n] of ctx.worked.get(k) || []) workedAgg.set(d, (workedAgg.get(d) ?? 0) + n);
    }
    const workedDivisions = [...workedAgg.entries()]
      .filter(([d]) => d !== base.primaryDivision)
      .map(([division, pieces]) => ({ division, pieces }))
      .sort((a, b) => b.pieces - a.pieces);

    return {
      key: base.key,
      name: base.name,
      primaryDivision: base.primaryDivision,
      subFeed: base.subFeed,
      secondaryDivisions: base.secondaryDivisions,
      workedDivisions,
      role: base.role,
      roleGroup: base.roleGroup,
      pod: base.pod,
      shift: base.shift,
      shiftClock: base.shiftClock,
      weekoff: base.weekoff,
      status,
      statusReason,
      offToday,
      offReason,
      onLeave,
      coveredBy,
      backup: base.backup,
      doneToday,
      doneYahoo: done.filter(onYahooSheet).length,
      verifiedToday,
      quota,
      inFlight,
      queue,
      loadYahoo,
      remaining,
      undatedPieces: undated,
      lastActive,
      sources: base.sources,
      flags: base.flags,
      employment: base.employment,
      notes: profile?.notes || '',
    };
  }

  /**
   * The content index is keyed on the resolver's spelling of a name; the
   * schedule may spell the same person differently ("Gokul Gopalakrishna
   * Pillai" vs the content's "Gokul"). Try the exact name, then the resolved
   * name, then a unique first-name match — the same ladder the resolver uses.
   */
  private contentKeys<V>(ctx: Ctx, index: Map<string, V>, name: string, division: string): string[] {
    const exact = lower(name);
    const resolved = lower(ctx.resolve(name, division));
    const first = firstToken(name);
    const sameFirst = first ? [...index.keys()].filter((k) => firstToken(k) === first) : [];

    // Associates and the newsroom float across every division, and each sheet
    // records them under whichever spelling it used — "Yash" in one, "Yash
    // Kotak" in another, "Rati Aggarwal" for "Rati Agrawal". For them a key
    // sharing the first name is the same person when it is the bare first name,
    // a longer form of a bare listed name, or a near-spelling of the full one;
    // for anyone else that would be a guess.
    if (FLOAT_POOLS.has(division)) {
      const single = exact.split(/[\s.]+/).length === 1;
      const all = new Set<string>(
        sameFirst.filter((k) => single || !k.includes(' ') || editDistance(k, exact) <= 2),
      );
      if (index.has(exact)) all.add(exact);
      if (index.has(resolved)) all.add(resolved);
      return [...all];
    }

    if (index.has(exact)) return [exact];
    if (index.has(resolved)) return [resolved];
    return sameFirst.length === 1 ? sameFirst : [];
  }

  private workFor(ctx: Ctx, index: Map<string, WorkItem[]>, name: string, division: string): WorkItem[] {
    const keys = this.contentKeys(ctx, index, name, division);
    if (keys.length === 1) return index.get(keys[0]) || [];
    const out: WorkItem[] = [];
    const seen = new Set<string>();
    for (const k of keys) for (const w of index.get(k) || []) if (!seen.has(w.id)) { seen.add(w.id); out.push(w); }
    return out;
  }

  private leaveOn(ctx: Ctx, name: string): ResourceLeave | null {
    for (const l of ctx.leavesFor(name)) {
      if (dateWithin(ctx.date, l.leaveStart, l.leaveEnd)) {
        return { from: l.leaveStart, to: l.leaveEnd, type: l.type };
      }
    }
    return null;
  }

  private statusFor(x: {
    roleGroup: string; offToday: boolean; offReason: string; quota: number | null;
    doneToday: number; inFlight: number; queue: number; remaining: number | null;
  }): { status: ResourceStatus; statusReason: string } {
    if (x.offToday) return { status: 'Off', statusReason: x.offReason };

    if (x.roleGroup === 'editor') {
      if (x.queue === 0) return { status: 'Free', statusReason: 'Nothing waiting for review' };
      if (x.queue <= EDITOR_BUSY_QUEUE) {
        return { status: 'Available', statusReason: `${x.queue} waiting for review` };
      }
      return { status: 'Busy', statusReason: `${x.queue} waiting for review` };
    }

    if (x.quota == null) {
      if (x.inFlight === 0) return { status: 'Free', statusReason: 'Nothing in flight · no quota set' };
      if (x.inFlight <= WRITER_AVAILABLE_INFLIGHT) {
        return { status: 'Available', statusReason: `${x.inFlight} in flight · no quota set` };
      }
      return { status: 'Busy', statusReason: `${x.inFlight} in flight · no quota set` };
    }

    if (x.inFlight > x.quota) {
      return { status: 'Overloaded', statusReason: `${x.inFlight} in flight against a quota of ${x.quota}` };
    }
    if (x.doneToday >= x.quota) {
      return { status: 'At capacity', statusReason: `Quota met — ${x.doneToday}/${x.quota} submitted` };
    }
    if ((x.remaining ?? 0) <= 0) {
      return { status: 'At capacity', statusReason: `${x.doneToday} done + ${x.inFlight} in flight fills ${x.quota}` };
    }
    if (x.inFlight === 0) {
      return { status: 'Free', statusReason: `${x.remaining} of ${x.quota} still open, nothing in flight` };
    }
    return { status: 'Available', statusReason: `${x.remaining} of ${x.quota} still open` };
  }

  // ── Public surface ──

  async getBoard(params: {
    date?: string; divisions?: string[]; role?: string; statuses?: string[]; q?: string;
  }): Promise<ResourceBoardResult> {
    const ctx = await this.buildContext(params.date);
    let people = ctx.people;
    if (params.divisions?.length) {
      const set = new Set(params.divisions);
      people = people.filter(
        (p) => set.has(p.primaryDivision) || p.secondaryDivisions.some((d) => set.has(d)),
      );
    }
    if (params.role && params.role !== 'all') people = people.filter((p) => p.roleGroup === params.role);
    if (params.statuses?.length) {
      const set = new Set(params.statuses);
      people = people.filter((p) => set.has(p.status));
    }
    if (params.q) {
      const q = lower(params.q);
      people = people.filter((p) => lower(p.name).includes(q) || lower(p.role).includes(q));
    }

    const counts: Record<ResourceStatus, number> = {
      Off: 0, Free: 0, Available: 0, 'At capacity': 0, Overloaded: 0, Busy: 0,
    };
    for (const p of ctx.people) counts[p.status]++;

    return { date: ctx.date, weekday: ctx.weekday, currentShift: ctx.shift, people, counts };
  }

  async getSummary(date?: string): Promise<ResourceSummaryResult> {
    const ctx = await this.buildContext(date);

    const divisions = new Set<string>();
    for (const q of ctx.quotas) divisions.add(q.division);
    for (const w of ctx.items) divisions.add(w.division);
    for (const d of ctx.yahooQuota.keys()) divisions.add(d);
    divisions.delete('Unknown');

    const rows: DivisionResourceSummary[] = [];
    for (const division of [...divisions].sort()) {
      const quotas = ctx.quotas.filter((q) => q.division === division);
      const work = ctx.items.filter((w) => w.division === division);
      const people = ctx.people.filter((p) => p.primaryDivision === division);

      // The DailyDynamics quota is the Critical Flow desk's; Yahoo sets its
      // own, so each is measured against the pieces on its own sheet.
      const today = work.filter((w) => onCfSheet(w) && submissionDay(w) === ctx.date);
      const submittedEmp = today.filter((w) => submissionShift(w) === 'EMP').length;
      const submittedLnp = today.length - submittedEmp;
      const quotaEmp = quotas.reduce((s, q) => s + q.emp, 0);
      const quotaLnp = quotas.reduce((s, q) => s + q.lnp, 0);
      const quotaTotal = quotas.reduce((s, q) => s + q.total, 0);
      const yahooWork = work.filter(onYahooSheet);

      let awaitingEditorial = 0, awaitingSubmission = 0, unassigned = 0, openSendBacks = 0;
      for (const w of work) {
        if (w.pending === 'Awaiting Editorial') {
          awaitingEditorial++;
          if (!w.editors.length) unassigned++;
        } else if (w.pending === 'Awaiting Submission') awaitingSubmission++;
        else if (w.pending === 'Sent Back') openSendBacks++;
      }

      const writers = people.filter((p) => p.roleGroup === 'writer');
      const editors = people.filter((p) => p.roleGroup === 'editor');
      const conflict = quotas.find((q) => q.editorialChartTotal != null);

      const subFeeds = quotas
        .filter((q) => q.subFeed)
        .map((q) => ({
          subFeed: q.subFeed,
          quota: q.total,
          submitted: today.filter((w) => w.subFeed === q.subFeed).length,
        }));

      const shiftQuota = ctx.shift === 'EMP' ? quotaEmp : quotaLnp;
      const shiftDone = ctx.shift === 'EMP' ? submittedEmp : submittedLnp;

      rows.push({
        division,
        poc: quotas.find((q) => q.poc)?.poc || '',
        architecture: quotas.find((q) => q.architecture)?.architecture || '',
        quotaEmp, quotaLnp, quotaTotal,
        quotaMissing: quotas.length === 0,
        quotaConflict: conflict
          ? quotas.reduce((s, q) => s + (q.editorialChartTotal ?? q.total), 0)
          : null,
        submittedEmp, submittedLnp, submittedTotal: today.length,
        publishedToday: work.filter((w) => onCfSheet(w) && w.publishedDate === ctx.date && w.published).length,
        gapCurrentShift: Math.max(shiftQuota - shiftDone, 0),
        gapDay: Math.max(quotaTotal - today.length, 0),
        yahooQuota: ctx.yahooQuota.get(division) ?? null,
        yahooSubmitted: yahooWork.filter((w) => submissionDay(w) === ctx.date).length,
        yahooPublished: yahooWork.filter((w) => w.publishedDate === ctx.date && w.published).length,
        awaitingEditorial, awaitingSubmission, unassignedEditorial: unassigned, openSendBacks,
        writersTotal: writers.length,
        writersOff: writers.filter((p) => p.offToday).length,
        writersFree: writers.filter((p) => p.status === 'Free').length,
        writersAvailable: writers.filter((p) => p.status === 'Available').length,
        editorsTotal: editors.length,
        editorsOff: editors.filter((p) => p.offToday).length,
        editorsFree: editors.filter((p) => p.status === 'Free').length,
        undatedPieces: work.filter((w) => !w.date).length,
        subFeeds,
      });
    }

    rows.sort((a, b) => b.quotaTotal - a.quotaTotal || a.division.localeCompare(b.division));

    return {
      date: ctx.date,
      weekday: ctx.weekday,
      currentShift: ctx.shift,
      divisions: rows,
      totals: {
        quota: rows.reduce((s, r) => s + r.quotaTotal, 0),
        submitted: rows.reduce((s, r) => s + r.submittedTotal, 0),
        published: rows.reduce((s, r) => s + r.publishedToday, 0),
        gapDay: rows.reduce((s, r) => s + r.gapDay, 0),
        yahooPublished: rows.reduce((s, r) => s + r.yahooPublished, 0),
        awaitingEditorial: rows.reduce((s, r) => s + r.awaitingEditorial, 0),
        writersFree: ctx.people.filter((p) => p.roleGroup === 'writer' && p.status === 'Free').length,
        editorsFree: ctx.people.filter((p) => p.roleGroup === 'editor' && p.status === 'Free').length,
        onLeave: ctx.people.filter((p) => !!p.onLeave).length,
      },
    };
  }

  /**
   * Who could pick up work for `division` today. Scores favour the absent
   * person's named backup, then the floating pools, then people whose own
   * division it is, then anyone with a track record there — and within each
   * tier, whoever has the most room left. Every candidate carries the reasons
   * it ranked, so the manager can see why rather than trust a number.
   */
  async suggest(params: {
    division: string; role?: string; forPerson?: string; date?: string;
  }): Promise<SuggestResult> {
    const ctx = await this.buildContext(params.date);
    const role = params.role && params.role !== 'all' ? params.role : 'all';
    const division = params.division;

    const absent = params.forPerson
      ? ctx.people.find((p) => lower(p.name) === lower(params.forPerson!) || p.key === params.forPerson)
      : undefined;
    const backupName = absent?.backup ? lower(absent.backup) : '';

    const candidates: SuggestCandidate[] = [];
    for (const p of ctx.people) {
      if (absent && p.key === absent.key) continue;
      if (role !== 'all' && p.roleGroup !== role) continue;
      if (p.roleGroup !== 'writer' && p.roleGroup !== 'editor') continue;
      if (p.offToday) continue;

      let score = 0;
      const reasons: string[] = [];

      if (backupName && firstToken(p.name) === firstToken(backupName)) {
        score += 100;
        reasons.push(`Named backup for ${absent!.name}`);
      }
      if (p.primaryDivision === 'Associate') {
        score += 60;
        reasons.push('Associate — floats across divisions');
      } else if (p.primaryDivision === 'Newsroom') {
        score += 40;
        reasons.push('Newsroom — edits and publishes across divisions');
      }
      if (p.primaryDivision === division) {
        score += 50;
        reasons.push(`Primary division is ${division}`);
      } else if (p.secondaryDivisions.includes(division)) {
        score += 35;
        reasons.push(`Listed as secondary for ${division}`);
      }
      const worked = p.workedDivisions.find((w) => w.division === division);
      if (worked && p.primaryDivision !== division) {
        score += 20 + Math.min(worked.pieces, 10);
        reasons.push(`Has done ${worked.pieces} ${division} piece${worked.pieces === 1 ? '' : 's'}`);
      }

      if (p.roleGroup === 'writer') {
        if (p.remaining != null) {
          score += p.remaining * 3;
          reasons.push(`${p.remaining} of ${p.quota} still open today`);
        } else if (p.status === 'Free') {
          score += 8;
          reasons.push('Nothing in flight (no quota set)');
        } else if (p.status === 'Available') {
          score += 3;
          reasons.push(`${p.inFlight} in flight (no quota set)`);
        }
      } else {
        score += Math.max(EDITOR_BUSY_QUEUE - p.queue, 0) * 3;
        reasons.push(p.queue === 0 ? 'Review queue empty' : `${p.queue} waiting for review`);
      }
      if (p.status === 'At capacity' || p.status === 'Overloaded' || p.status === 'Busy') {
        score -= 25;
        reasons.push(`Currently ${p.status.toLowerCase()}`);
      }
      if (p.employment === 'On notice') reasons.push('On notice');
      if (p.shift) reasons.push(`${p.shift} shift${p.shiftClock ? ` · ${p.shiftClock}` : ''}`);

      if (score <= 0 && !reasons.length) continue;
      candidates.push({ person: p, score, reasons });
    }

    candidates.sort((a, b) => b.score - a.score || a.person.name.localeCompare(b.person.name));
    return {
      date: ctx.date,
      division,
      role,
      forPerson: absent?.name ?? params.forPerson ?? null,
      candidates: candidates.slice(0, 12),
    };
  }

  async getHealth(): Promise<ScheduleHealthResult> {
    const ctx = await this.buildContext();
    const [sched, leaves, quotas, yp] = await Promise.all([
      this.peopleRepo.find(), this.leaveRepo.find(), this.quotaRepo.find(), this.ypRepo.find(),
    ]);
    const flags: ScheduleHealthFlag[] = [];
    const push = (issue: string, items: string[], detail: string) => {
      if (items.length) flags.push({ issue, count: items.length, detail, items: items.slice(0, 20) });
    };

    push(
      'Role disagrees between tabs',
      sched.filter((s) => s.flags.includes('role-conflict')).map((s) => `${s.name} (${s.primaryDivision})`),
      'Writer Info lists them as a writer; Editor Info / Roles & Contact list them as an editor. Treated as an editor.',
    );
    push(
      'Marked exited but still listed',
      sched.filter((s) => s.flags.includes('exited')).map((s) => `${s.name} (${s.primaryDivision})`),
      'Roles & Contact\'s exit list names them, but Writer Info or Editor Info still has them. Shown as inactive.',
    );
    push(
      'Quota differs between DailyDynamics and Editorial Chart',
      quotas.filter((q) => q.editorialChartTotal != null)
        .map((q) => `${q.sourceName}: ${q.total} vs ${q.editorialChartTotal}`),
      'DailyDynamics is used; the Editorial Chart figure is shown alongside on the summary.',
    );
    const attached = new Set<string>();
    for (const s of sched) for (const l of ctx.leavesFor(s.name)) attached.add(l.id);
    push(
      'Leave logged for a name not on any schedule tab',
      [...new Set(leaves.filter((l) => !attached.has(l.id)).map((l) => l.name))],
      'These leave records cannot be attached to one person, so they will not mark anyone Off. A first name alone only attaches when nobody else shares it.',
    );
    if (!leaves.some((l) => l.roleTag === 'writer')) {
      flags.push({
        issue: 'No writer leave recorded',
        count: 1,
        detail: 'CF Writer Leaves has nothing recent. Writers will never show as On leave until it is used.',
        items: [],
      });
    }
    const undatedByDiv = new Map<string, number>();
    for (const w of ctx.items) if (!w.date) undatedByDiv.set(w.division, (undatedByDiv.get(w.division) ?? 0) + 1);
    push(
      'Pieces with no timestamps',
      [...undatedByDiv.entries()].sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d}: ${n}`),
      'These cannot count toward anyone\'s output today, so those writers will look quieter than they are.',
    );
    const quotaDivs = new Set(quotas.map((q) => q.division));
    push(
      'Division with Critical Flow content but no quota',
      [...new Set(ctx.items.filter(onCfSheet).map((w) => w.division))]
        .filter((d) => d !== 'Unknown' && !quotaDivs.has(d)),
      'Gap-to-quota cannot be computed for these.',
    );
    const unknownYahoo = new Map<string, number>();
    for (const y of yp) {
      if (!parseDivisions(y.division).length) unknownYahoo.set(y.division, (unknownYahoo.get(y.division) ?? 0) + 1);
    }
    push(
      'Yahoo division label not recognised',
      [...unknownYahoo.entries()].sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d || '(blank)'}: ${n}`),
      'These Yahoo pieces cannot be placed in a board division, so they count for their people but not for any division card.',
    );

    const unlisted = ctx.people
      .filter((p) => p.flags.includes('unlisted'))
      .map((p) => ({
        label: `${p.name} (${p.primaryDivision})`,
        pieces: [...(ctx.worked.get(lower(p.name))?.values() ?? [])].reduce((a, b) => a + b, 0),
      }))
      .sort((a, b) => b.pieces - a.pieces);
    push(
      'Working but not on the schedule',
      unlisted.map((u) => `${u.label} ×${u.pieces}`),
      'Writing or editing on the content sheets, but not in Writer Info, Editor Info or Roles & Contact. Add them there so leave, shift and backup apply — until then they show with no schedule details.',
    );

    // Two spellings of what is almost certainly one person inside a division.
    // Not merged — a one-letter difference is usually a typo but is sometimes
    // two people — so it is raised for the sheets to settle.
    const similar: string[] = [];
    const byDiv = new Map<string, string[]>();
    for (const p of ctx.people) {
      if (!byDiv.has(p.primaryDivision)) byDiv.set(p.primaryDivision, []);
      byDiv.get(p.primaryDivision)!.push(p.name);
    }
    for (const [division, names] of byDiv) {
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const a = lower(names[i]);
          const b = lower(names[j]);
          const fa = firstToken(a);
          const fb = firstToken(b);
          // Same first name, a one-letter slip in the first name ("Maleeha" /
          // "Maleehah Shakeel"), or a one-letter slip anywhere in a longish name.
          if (
            fa === fb ||
            (fa.length >= 5 && editDistance(fa, fb) <= 1) ||
            (a.length >= 6 && editDistance(a, b) <= 1)
          ) {
            similar.push(`${division}: ${names[i]} / ${names[j]}`);
          }
        }
      }
    }
    push(
      'Similar names in one division',
      similar,
      'Probably one person spelt two ways across sheets; counted separately until the spellings match.',
    );

    const status = this.sync.getStatus();
    return {
      sheetConfigured: status.sheetConfigured,
      lastSyncTime: status.lastSyncTime,
      syncError: status.error,
      people: sched.length,
      leaves: leaves.length,
      quotas: quotas.length,
      flags,
    };
  }

  // ── Profiles (the one in-app editable thing) ──

  async getProfiles(): Promise<ResourceProfile[]> {
    const ctx = await this.buildContext();
    return ctx.people
      .filter((p) => p.roleGroup === 'writer' || p.roleGroup === 'editor')
      .map((p) => {
        const pr = ctx.profileFor(p.primaryDivision, p.name);
        return {
          key: p.key,
          division: p.primaryDivision,
          name: p.name,
          dailyQuota: pr?.dailyQuota ?? null,
          notes: pr?.notes ?? '',
          updatedAt: pr?.updatedAt ? new Date(pr.updatedAt).toISOString() : null,
        };
      });
  }

  async updateProfiles(body: any): Promise<{ updated: number; profiles: ResourceProfile[] }> {
    const list = Array.isArray(body) ? body : body?.profiles;
    if (!Array.isArray(list) || list.length === 0) {
      throw new BadRequestException('`profiles` must be a non-empty array');
    }
    const rows: ResProfile[] = [];
    for (const raw of list) {
      const key = String(raw?.key ?? '').trim();
      const [division, ...rest] = key.split('|');
      const name = rest.join('|');
      if (!division || !name) throw new BadRequestException(`Bad profile key: ${key}`);
      const q = raw?.dailyQuota;
      const dailyQuota =
        q == null || q === '' ? null : Math.max(0, Math.round(Number(q)));
      if (dailyQuota != null && !Number.isFinite(dailyQuota)) {
        throw new BadRequestException(`Bad dailyQuota for ${key}`);
      }
      const e = new ResProfile();
      e.id = key;
      e.division = division;
      e.name = name;
      e.dailyQuota = dailyQuota;
      e.notes = String(raw?.notes ?? '').slice(0, 2000);
      rows.push(e);
    }
    await this.profileRepo.upsert(rows, ['id']);
    return { updated: rows.length, profiles: await this.getProfiles() };
  }

  /**
   * The retired Division Info rosters recorded per-writer daily targets
   * (College Football, NFL) that the schedule workbook does not carry. Copied
   * once into profiles so those quotas survive the switch; a person who already
   * has a profile is left alone, so this is safe to run on every boot until the
   * old cf_roster table is dropped.
   */
  private async carryOverRosterTargets(): Promise<void> {
    let legacy: { division: string; name: string; dailyTarget: number }[];
    try {
      legacy = await this.profileRepo.query(
        'SELECT division, name, "dailyTarget" FROM cf_roster WHERE "dailyTarget" IS NOT NULL',
      );
    } catch {
      return; // table already dropped
    }
    if (!legacy.length) return;

    const ctx = await this.buildContext();
    const rows = new Map<string, ResProfile>();
    let unmatched = 0;
    for (const l of legacy) {
      const want = lower(ctx.resolve(l.name, l.division));
      const candidates = ctx.people.filter((p) => lower(ctx.resolve(p.name, l.division)) === want);
      const person =
        candidates.find((p) => p.primaryDivision === l.division) ??
        (candidates.length === 1 ? candidates[0] : undefined);
      if (!person) { unmatched++; continue; }
      if (rows.has(person.key) || ctx.profileFor(person.primaryDivision, person.name)) continue;
      const e = new ResProfile();
      e.id = person.key;
      e.division = person.primaryDivision;
      e.name = person.name;
      e.dailyQuota = Math.max(0, Math.round(Number(l.dailyTarget)));
      e.notes = 'Daily target carried over from the Division Info roster';
      rows.set(person.key, e);
    }
    if (rows.size) {
      await this.profileRepo.upsert([...rows.values()], ['id']);
      this.logger.log(`Carried over ${rows.size} roster daily targets into profiles`);
    }
    if (unmatched) this.logger.warn(`${unmatched} roster daily targets matched no one on the board`);
  }
}

/** Levenshtein distance, short-circuited when the lengths alone put it above 2. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let left = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = Math.min(
        prev[j] + 1,
        left + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev[j - 1] = left;
      left = cur;
    }
    prev[b.length] = left;
  }
  return prev[b.length];
}

function safeJson(s: string): Record<string, any> {
  try {
    const v = JSON.parse(s || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
