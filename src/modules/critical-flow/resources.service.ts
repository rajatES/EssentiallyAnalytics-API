import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CriticalFlowService } from './critical-flow.service';
import { CfPiece } from './entities/cf-piece.entity';
import { CfRosterPerson } from './entities/cf-roster-person.entity';
import { CfSchedulePerson } from './entities/cf-schedule-person.entity';
import { CfLeave } from './entities/cf-leave.entity';
import { CfDivisionQuota } from './entities/cf-division-quota.entity';
import { CfResourceProfile } from './entities/cf-resource-profile.entity';
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
import { isPublished, pendingStage, subFeedOf } from './stages';
import { parseShift } from './normalization';
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

interface LeaveIdx {
  byName: Map<string, CfLeave[]>;
}

interface Ctx {
  date: string;
  weekday: string;
  now: Date;
  shift: Shift;
  pieces: CfPiece[];
  resolve: (n: string, d: string) => string;
  /** lower-cased resolved writer name → their pieces (all divisions) */
  byWriter: Map<string, CfPiece[]>;
  byEditor: Map<string, CfPiece[]>;
  /** lower-cased resolved name → division → piece count */
  worked: Map<string, Map<string, number>>;
  leaves: LeaveIdx;
  profiles: Map<string, CfResourceProfile>;
  quotas: CfDivisionQuota[];
  people: ResourcePerson[];
}

function lower(s: string): string {
  return s.toLowerCase();
}

function addTo<K>(m: Map<K, CfPiece[]>, k: K, p: CfPiece) {
  const arr = m.get(k);
  if (arr) arr.push(p);
  else m.set(k, [p]);
}

/** The desk day a piece's submission counts toward, with the editorial stamp
 *  standing in where a division never fills the submission column. */
function submissionDay(p: CfPiece): string | null {
  const stamp = p.submittedAt || p.editorAt;
  return stamp ? opsDayOf(new Date(stamp)) : null;
}

function submissionShift(p: CfPiece): Shift | null {
  const stamp = p.submittedAt || p.editorAt;
  return stamp ? shiftOf(new Date(stamp)) : null;
}

@Injectable()
export class ResourcesService {
  constructor(
    private readonly cf: CriticalFlowService,
    @InjectRepository(CfPiece) private readonly pieceRepo: Repository<CfPiece>,
    @InjectRepository(CfRosterPerson) private readonly rosterRepo: Repository<CfRosterPerson>,
    @InjectRepository(CfSchedulePerson) private readonly schedRepo: Repository<CfSchedulePerson>,
    @InjectRepository(CfLeave) private readonly leaveRepo: Repository<CfLeave>,
    @InjectRepository(CfDivisionQuota) private readonly quotaRepo: Repository<CfDivisionQuota>,
    @InjectRepository(CfResourceProfile) private readonly profileRepo: Repository<CfResourceProfile>,
  ) {}

  // ── Context ──

  private async buildContext(dateParam?: string): Promise<Ctx> {
    const now = new Date();
    const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : todayIst(now);
    const [pieces, roster, sched, leaves, quotas, profiles, resolve] = await Promise.all([
      this.pieceRepo.find(),
      this.rosterRepo.find(),
      this.schedRepo.find(),
      this.leaveRepo.find(),
      this.quotaRepo.find(),
      this.profileRepo.find(),
      this.cf.nameResolver(),
    ]);

    const byWriter = new Map<string, CfPiece[]>();
    const byEditor = new Map<string, CfPiece[]>();
    const worked = new Map<string, Map<string, number>>();
    const touch = (name: string, division: string, p: CfPiece, m: Map<string, CfPiece[]>) => {
      if (!name || name === 'Unknown') return;
      const key = lower(resolve(name, division));
      addTo(m, key, p);
      if (!worked.has(key)) worked.set(key, new Map());
      const w = worked.get(key)!;
      w.set(division, (w.get(division) ?? 0) + 1);
    };
    for (const p of pieces) {
      touch(p.writer, p.division, p, byWriter);
      touch(p.editor, p.division, p, byEditor);
      if (p.editor2) touch(p.editor2, p.division, p, byEditor);
    }

    const leaveIdx: LeaveIdx = { byName: new Map() };
    for (const l of leaves) {
      const k = lower(l.name);
      if (!leaveIdx.byName.has(k)) leaveIdx.byName.set(k, []);
      leaveIdx.byName.get(k)!.push(l);
    }

    const profileMap = new Map(profiles.map((p) => [p.id, p]));

    const ctx: Ctx = {
      date,
      weekday: weekdayNameOf(date),
      now,
      shift: currentShift(now),
      pieces,
      resolve,
      byWriter,
      byEditor,
      worked,
      leaves: leaveIdx,
      profiles: profileMap,
      quotas,
      people: [],
    };
    ctx.people = this.buildPeople(ctx, sched, roster);
    return ctx;
  }

  /**
   * The people universe: the managers' schedule list first, enriched from the
   * per-division rosters, plus anyone doing work who appears on neither — so a
   * writer nobody has added to a sheet yet still shows up rather than vanishing.
   */
  private buildPeople(ctx: Ctx, sched: CfSchedulePerson[], roster: CfRosterPerson[]): ResourcePerson[] {
    const out = new Map<string, ResourcePerson>();
    const keyOf = (division: string, name: string) => `${division}|${name}`;

    // Identity for de-duplication is the division-resolved, lower-cased name,
    // so "Abhimanyu Gupta" (schedule) and "Abhimanyu" (roster) are one Golf
    // editor. The DISPLAY name is whatever the first source spelt it — the
    // managers' schedule wins over the rosters, which win over the content —
    // rather than the resolver's pick, which favours the commonest content
    // spelling and would show "aadesh" where the schedule says "Aadesh".
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

    const rosterIdx = new Map<string, CfRosterPerson>();
    for (const r of roster) rosterIdx.set(identity(r.division, r.name), r);

    for (const s of sched) {
      if (seen.has(identity(s.primaryDivision, s.name))) continue;
      note(s.primaryDivision, s.name);
      const name = s.name;
      const key = keyOf(s.primaryDivision, name);
      const r = rosterIdx.get(identity(s.primaryDivision, s.name));
      const weekPlan = safeJson(s.weekPlan);
      out.set(key, this.materialise(ctx, {
        key,
        name,
        primaryDivision: s.primaryDivision,
        subFeed: s.subFeed,
        secondaryDivisions: s.secondaryDivisions || [],
        role: s.role || r?.role || '',
        roleGroup: s.roleGroup !== 'other' ? s.roleGroup : (r?.roleGroup || 'other'),
        pod: s.pod,
        // Rosters put either a clock ("5 PM - 2 AM") or a shift code ("EMP")
        // in their Shift column; route each to the field it actually is.
        shift: s.shift || parseShift(r?.shift),
        shiftClock: s.shiftClock || (parseShift(r?.shift) ? '' : r?.shift || ''),
        weekoff: s.weekoff || r?.weekoff || '',
        backup: s.backup,
        email: r?.email || '',
        rosterTarget: r?.dailyTarget ?? null,
        weekPlan,
        sources: ['schedule', ...(r ? ['roster'] : [])],
        flags: s.flags ? s.flags.split(',').filter(Boolean) : [],
        status: s.status,
      }));
    }

    for (const r of roster) {
      if (seen.has(identity(r.division, r.name))) continue;
      if (r.roleGroup !== 'writer' && r.roleGroup !== 'editor') continue; // leads are not allocatable
      note(r.division, r.name);
      const name = r.name;
      const key = keyOf(r.division, name);
      out.set(key, this.materialise(ctx, {
        key, name,
        primaryDivision: r.division,
        subFeed: '',
        secondaryDivisions: [],
        role: r.role,
        roleGroup: r.roleGroup,
        pod: '',
        shift: parseShift(r.shift),
        shiftClock: parseShift(r.shift) ? '' : r.shift,
        weekoff: r.weekoff,
        backup: '',
        email: r.email,
        rosterTarget: r.dailyTarget,
        weekPlan: {},
        sources: ['roster'],
        flags: [],
        status: '',
      }));
    }

    // Content-only people: doing the work, on nobody's sheet.
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
      const display = sample
        ? ctx.resolve(asWriter >= asEditor ? sample.writer : sample.editor, sample.division)
        : lname;
      const key = keyOf(primary, display);
      out.set(key, this.materialise(ctx, {
        key, name: display,
        primaryDivision: primary,
        subFeed: '',
        secondaryDivisions: [],
        role: asWriter >= asEditor ? 'Writer' : 'Editor',
        roleGroup: asWriter >= asEditor ? 'writer' : 'editor',
        pod: '', shift: '', shiftClock: '', weekoff: '', backup: '', email: '',
        rosterTarget: null, weekPlan: {},
        sources: ['content'],
        flags: ['unlisted'],
        status: '',
      }));
    }

    return [...out.values()].sort(
      (a, b) => a.primaryDivision.localeCompare(b.primaryDivision) || a.name.localeCompare(b.name),
    );
  }

  private materialise(
    ctx: Ctx,
    base: {
      key: string; name: string; primaryDivision: string; subFeed: string;
      secondaryDivisions: string[]; role: string; roleGroup: string; pod: string;
      shift: string; shiftClock: string; weekoff: string; backup: string; email: string;
      rosterTarget: number | null; weekPlan: Record<string, any>;
      sources: string[]; flags: string[]; status: string;
    },
  ): ResourcePerson {
    const lname = lower(base.name);
    const asWriter = this.piecesFor(ctx, ctx.byWriter, base.name, base.primaryDivision);
    const asEditor = this.piecesFor(ctx, ctx.byEditor, base.name, base.primaryDivision);
    const mine = base.roleGroup === 'editor' ? asEditor : asWriter;

    // ── Off today? ──
    const onLeave = this.leaveOn(ctx, lname);
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
    if (base.status && /inactive|left|resigned/i.test(base.status)) {
      offReason = offReason || `Inactive (${base.status})`;
    }
    const offToday = !!offReason;

    // ── Output today ──
    const doneToday = base.roleGroup === 'editor'
      ? asEditor.filter((p) => p.publishedDate === ctx.date && isPublished(p)).length
      : asWriter.filter((p) => submissionDay(p) === ctx.date).length;
    const verifiedToday = base.roleGroup === 'editor'
      ? asEditor.filter((p) => p.editorAt && opsDayOf(new Date(p.editorAt)) === ctx.date).length
      : 0;

    // ── Load ──
    let inFlight = 0;
    let queue = 0;
    for (const p of mine) {
      const st = pendingStage(p, ctx.now);
      if (!st) continue;
      if (base.roleGroup === 'editor') {
        if (st === 'Awaiting Editorial' || st === 'Awaiting Live') queue++;
      } else if (st === 'Awaiting Submission' || st === 'Sent Back') {
        inFlight++;
      }
    }

    const profile = ctx.profiles.get(base.key);
    const quota = profile?.dailyQuota ?? base.rosterTarget ?? null;
    const remaining = quota == null ? null : Math.max(quota - doneToday - inFlight, 0);

    const { status, statusReason } = this.statusFor({
      roleGroup: base.roleGroup, offToday, offReason, quota, doneToday, inFlight, queue, remaining,
    });

    const undated = mine.filter((p) => !p.date).length;
    let lastActive: string | null = null;
    for (const p of mine) if (p.date && (!lastActive || p.date > lastActive)) lastActive = p.date;

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
      verifiedToday,
      quota,
      inFlight,
      queue,
      remaining,
      undatedPieces: undated,
      lastActive,
      email: base.email,
      sources: base.sources,
      flags: base.flags,
      notes: profile?.notes || '',
    };
  }

  /**
   * The content index is keyed on the resolver's spelling of a name; a sheet
   * may spell the same person differently ("Gokul Gopalakrishna Pillai" vs the
   * content's "Gokul"). Try the exact name, then the resolved name, then a
   * unique first-name match — the same ladder the resolver itself uses.
   */
  private contentKeys<V>(ctx: Ctx, index: Map<string, V>, name: string, division: string): string[] {
    const exact = lower(name);
    const resolved = lower(ctx.resolve(name, division));
    const first = exact.split(/[\s.]+/)[0];
    const sameFirst = first ? [...index.keys()].filter((k) => k.split(/[\s.]+/)[0] === first) : [];

    // Associates float across every division by definition, and the content
    // records them under whichever spelling that division's sheet used —
    // "Yash" in one, "Yash Kotak" in another. For them, every key sharing the
    // first name is the same person; for everyone else that would be a guess.
    if (division === 'Associate' && exact.split(/[\s.]+/).length === 1) {
      const all = new Set<string>(sameFirst);
      if (index.has(exact)) all.add(exact);
      if (index.has(resolved)) all.add(resolved);
      return [...all];
    }

    if (index.has(exact)) return [exact];
    if (index.has(resolved)) return [resolved];
    return sameFirst.length === 1 ? sameFirst : [];
  }

  private contentKey<V>(ctx: Ctx, index: Map<string, V>, name: string, division: string): string | null {
    return this.contentKeys(ctx, index, name, division)[0] ?? null;
  }

  private piecesFor(ctx: Ctx, index: Map<string, CfPiece[]>, name: string, division: string): CfPiece[] {
    const keys = this.contentKeys(ctx, index, name, division);
    if (keys.length === 1) return index.get(keys[0]) || [];
    const out: CfPiece[] = [];
    const seen = new Set<string>();
    for (const k of keys) for (const p of index.get(k) || []) if (!seen.has(p.id)) { seen.add(p.id); out.push(p); }
    return out;
  }

  private leaveOn(ctx: Ctx, lname: string): ResourceLeave | null {
    const recs = ctx.leaves.byName.get(lname);
    if (!recs) return null;
    for (const l of recs) {
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
    for (const p of ctx.pieces) divisions.add(p.division);
    divisions.delete('Unknown');

    const rows: DivisionResourceSummary[] = [];
    for (const division of [...divisions].sort()) {
      const quotas = ctx.quotas.filter((q) => q.division === division);
      const pieces = ctx.pieces.filter((p) => p.division === division);
      const people = ctx.people.filter((p) => p.primaryDivision === division);

      const today = pieces.filter((p) => submissionDay(p) === ctx.date);
      const submittedEmp = today.filter((p) => submissionShift(p) === 'EMP').length;
      const submittedLnp = today.length - submittedEmp;
      const quotaEmp = quotas.reduce((s, q) => s + q.emp, 0);
      const quotaLnp = quotas.reduce((s, q) => s + q.lnp, 0);
      const quotaTotal = quotas.reduce((s, q) => s + q.total, 0);

      let awaitingEditorial = 0, awaitingSubmission = 0, unassigned = 0, openSendBacks = 0;
      for (const p of pieces) {
        const st = pendingStage(p, ctx.now);
        if (st === 'Awaiting Editorial') {
          awaitingEditorial++;
          if (p.editor === 'Unknown') unassigned++;
        } else if (st === 'Awaiting Submission') awaitingSubmission++;
        else if (st === 'Sent Back') openSendBacks++;
      }

      const writers = people.filter((p) => p.roleGroup === 'writer');
      const editors = people.filter((p) => p.roleGroup === 'editor');
      const conflict = quotas.find((q) => q.editorialChartTotal != null);

      const subFeeds = quotas
        .filter((q) => q.subFeed)
        .map((q) => ({
          subFeed: q.subFeed,
          quota: q.total,
          submitted: today.filter((p) => subFeedOf(p) === q.subFeed).length,
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
        publishedToday: pieces.filter((p) => p.publishedDate === ctx.date && isPublished(p)).length,
        gapCurrentShift: Math.max(shiftQuota - shiftDone, 0),
        gapDay: Math.max(quotaTotal - today.length, 0),
        awaitingEditorial, awaitingSubmission, unassignedEditorial: unassigned, openSendBacks,
        writersTotal: writers.length,
        writersOff: writers.filter((p) => p.offToday).length,
        writersFree: writers.filter((p) => p.status === 'Free').length,
        writersAvailable: writers.filter((p) => p.status === 'Available').length,
        editorsTotal: editors.length,
        editorsOff: editors.filter((p) => p.offToday).length,
        editorsFree: editors.filter((p) => p.status === 'Free').length,
        undatedPieces: pieces.filter((p) => !p.date).length,
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
        awaitingEditorial: rows.reduce((s, r) => s + r.awaitingEditorial, 0),
        writersFree: ctx.people.filter((p) => p.roleGroup === 'writer' && p.status === 'Free').length,
        editorsFree: ctx.people.filter((p) => p.roleGroup === 'editor' && p.status === 'Free').length,
        onLeave: ctx.people.filter((p) => !!p.onLeave).length,
      },
    };
  }

  /**
   * Who could pick up work for `division` today. Scores favour the absent
   * person's named backup, then the floating Associate pool, then people whose
   * own division it is, then anyone with a track record there — and within
   * each tier, whoever has the most room left. Every candidate carries the
   * reasons it ranked, so the manager can see why rather than trust a number.
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

      if (backupName && lower(p.name).split(/[\s.]+/)[0] === backupName.split(/[\s.]+/)[0]) {
        score += 100;
        reasons.push(`Named backup for ${absent!.name}`);
      }
      if (p.primaryDivision === 'Associate') {
        score += 60;
        reasons.push('Associate — floats across divisions');
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
    const [sched, leaves, quotas, pieces] = await Promise.all([
      this.schedRepo.find(), this.leaveRepo.find(), this.quotaRepo.find(), this.pieceRepo.find(),
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
      'Quota differs between DailyDynamics and Editorial Chart',
      quotas.filter((q) => q.editorialChartTotal != null)
        .map((q) => `${q.sourceName}: ${q.total} vs ${q.editorialChartTotal}`),
      'DailyDynamics is used; the Editorial Chart figure is shown alongside on the summary.',
    );
    const names = new Set(sched.map((s) => lower(s.name)));
    const firsts = new Set(sched.map((s) => lower(s.name).split(/[\s.]+/)[0]));
    push(
      'Leave logged for a name not on any schedule tab',
      [...new Set(leaves.filter((l) => !names.has(lower(l.name)) && !firsts.has(lower(l.name).split(/[\s.]+/)[0]))
        .map((l) => l.name))],
      'These leave records cannot be attached to a person and will not mark anyone Off.',
    );
    if (leaves.length && !leaves.some((l) => l.roleTag === 'writer')) {
      flags.push({
        issue: 'Writer leave log is empty',
        count: 1,
        detail: 'Only editor leave is being recorded. Writers will never show as On leave until it is used.',
        items: [],
      });
    }
    const undatedByDiv = new Map<string, number>();
    for (const p of pieces) if (!p.date) undatedByDiv.set(p.division, (undatedByDiv.get(p.division) ?? 0) + 1);
    push(
      'Pieces with no timestamps',
      [...undatedByDiv.entries()].sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d}: ${n}`),
      'These cannot count toward anyone\'s output today, so those writers will look quieter than they are.',
    );
    const divisionsWithContent = new Set(pieces.map((p) => p.division));
    const quotaDivs = new Set(quotas.map((q) => q.division));
    push(
      'Division with content but no quota',
      [...divisionsWithContent].filter((d) => d !== 'Unknown' && !quotaDivs.has(d)),
      'Gap-to-quota cannot be computed for these.',
    );

    // Two spellings of what is almost certainly one person inside a division
    // ("Maleeha Shakeel" on the roster, "Maleehah Shakeel" on the schedule).
    // Not merged — a one-letter difference is usually a typo but is sometimes
    // two people — so it is raised for the sheets to settle.
    const ctx = await this.buildContext();
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
          const sameFirst = a.split(/[\s.]+/)[0] === b.split(/[\s.]+/)[0];
          // Same first name, or a one-character slip anywhere in a longish name.
          if (sameFirst || (a.length >= 6 && editDistance(a, b) <= 1)) {
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

    return {
      scheduleSheetConfigured: !!process.env.CF_SCHEDULE_SHEET_ID,
      people: sched.length,
      leaves: leaves.length,
      quotas: quotas.length,
      flags,
    };
  }

  // ── Profiles (the one in-app editable thing) ──

  async getProfiles(): Promise<ResourceProfile[]> {
    const ctx = await this.buildContext();
    const byKey = ctx.profiles;
    return ctx.people
      .filter((p) => p.roleGroup === 'writer' || p.roleGroup === 'editor')
      .map((p) => {
        const pr = byKey.get(p.key);
        return {
          key: p.key,
          division: p.primaryDivision,
          name: p.name,
          dailyQuota: pr?.dailyQuota ?? p.quota,
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
    const rows: CfResourceProfile[] = [];
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
      const e = new CfResourceProfile();
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
}

/** Levenshtein distance, capped early — only "is it ≤ 1" matters here. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
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
