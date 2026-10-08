import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import { round } from '../production/analytics';
import { shiftDate, todayIst } from '../production/time';
import {
  CombinedProductionResult,
  CombinedProductionService,
  NO_WRITER,
} from '../resources/combined-production.service';
import { ResLeave } from '../resources/entities/res-leave.entity';
import { ResPerson } from '../resources/entities/res-person.entity';
import { SpRosterPerson } from '../stable-production/entities/sp-roster.entity';
import {
  GroupKey,
  ReportGroup,
  ReportMember,
  ReportWeek,
  WeekTally,
  WeeklyReport,
} from './types';

const WEEKS_SHOWN = 4;

/**
 * The groups and targets of the desk's own Week on Week sheet, in its order.
 * Targets are its "ideal efficiency": output per person per day worked.
 */
const GROUPS: Record<
  GroupKey,
  { name: string; target: number | null; measure: ReportGroup['measure'] }
> = {
  stables: { name: 'Stables writers', target: 4, measure: 'submitted' },
  'part-time': { name: 'Part-time writers', target: 4, measure: 'submitted' },
  msn: { name: 'Writers moved from MSN', target: 5, measure: 'submitted' },
  tenured: { name: 'Tenured writers', target: 5, measure: 'submitted' },
  editors: { name: 'Editors', target: 15, measure: 'published' },
  producers: { name: 'Producers', target: 5, measure: 'by role' },
  pod: { name: 'Pod', target: null, measure: 'written' },
  'non-pod': { name: 'Non-pod', target: null, measure: 'written' },
  associates: { name: 'Associates', target: null, measure: 'written' },
  'stables-editors': { name: 'Stables', target: null, measure: 'written' },
  unlisted: {
    name: 'Not on the schedule',
    target: null,
    measure: 'submitted',
  },
};

interface Placement {
  group: GroupKey;
  /** Whose output counts: what they submitted, or what they published. */
  as: 'writer' | 'editor';
}

interface Member extends Placement {
  name: string;
  division: string;
  role: string;
  rostered: boolean;
}

const dayOfWeek = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** The Sunday closing the Monday-to-Sunday week `date` falls in. */
const weekEndOf = (date: string) => shiftDate(date, (7 - dayOfWeek(date)) % 7);

const tally = (
  output: number,
  daysWorked: number,
  active: number,
): WeekTally => ({
  output,
  daysWorked,
  active,
  perDay: daysWorked > 0 ? round(output / daysWorked, 2) : null,
});

/**
 * Where a person on the schedule belongs, read from the Role the managers
 * write: producers by role, part-time and ex-MSN writers by a "(Part-time)" or
 * "(MSN)" in it, other writers as tenured. Editors other than producers are
 * placed by pod for their own writing, and the non-pod desks and associates
 * also for what they publish. Leads and the newsroom are outside the report,
 * as they are outside the sheet.
 */
function placementsOf(p: ResPerson): Placement[] {
  if (/^producer/i.test(p.role)) {
    return [
      {
        group: 'producers',
        as: p.roleGroup === 'editor' ? 'editor' : 'writer',
      },
    ];
  }
  if (p.roleGroup === 'writer') {
    const group: GroupKey = /part.?time/i.test(p.role)
      ? 'part-time'
      : /\bmsn\b/i.test(p.role)
        ? 'msn'
        : 'tenured';
    return [{ group, as: 'writer' }];
  }
  if (p.roleGroup !== 'editor') return [];
  if (/^pod$/i.test(p.pod)) return [{ group: 'pod', as: 'writer' }];
  if (/^non-pod$/i.test(p.pod)) {
    return [
      { group: 'editors', as: 'editor' },
      { group: 'non-pod', as: 'writer' },
    ];
  }
  // The associate pool also holds the newsroom backups; the sheet's
  // Associates row is only those whose role says Associate.
  if (/^associate$/i.test(p.pod)) {
    if (!/^associate/i.test(p.role))
      return [{ group: 'editors', as: 'editor' }];
    return [
      { group: 'editors', as: 'editor' },
      { group: 'associates', as: 'writer' },
    ];
  }
  return [];
}

@Injectable()
export class WeeklyReportService {
  constructor(
    private readonly production: CombinedProductionService,
    @InjectRepository(ResPerson)
    private readonly peopleRepo: Repository<ResPerson>,
    @InjectRepository(SpRosterPerson)
    private readonly stableRepo: Repository<SpRosterPerson>,
    @InjectRepository(ResLeave)
    private readonly leaveRepo: Repository<ResLeave>,
  ) {}

  /** The four weeks ending with the week `end` falls in, never past the last complete one. */
  async getReport(end?: string): Promise<WeeklyReport> {
    const today = todayIst();
    const latestEnd = shiftDate(today, -(dayOfWeek(today) || 7));
    const last =
      end && /^\d{4}-\d{2}-\d{2}$/.test(end) ? weekEndOf(end) : latestEnd;
    const finalEnd = last > latestEnd ? latestEnd : last;
    const weeks: ReportWeek[] = Array.from({ length: WEEKS_SHOWN }, (_, i) => {
      const weekEnd = shiftDate(finalEnd, -7 * (WEEKS_SHOWN - 1 - i));
      return { start: shiftDate(weekEnd, -6), end: weekEnd };
    });
    const current = weeks[weeks.length - 1];

    const [people, stableDesk, leave, results] = await Promise.all([
      this.peopleRepo.find(),
      this.stableRepo.find(),
      this.leaveRepo.find({
        select: { name: true },
        where: {
          leaveStart: LessThanOrEqual(current.start),
          leaveEnd: MoreThanOrEqual(current.end),
        },
      }),
      Promise.all(
        weeks.map((w) =>
          this.production.get({ startDate: w.start, endDate: w.end }),
        ),
      ),
    ]);
    const awayAllWeek = new Set(leave.map((l) => l.name.toLowerCase()));

    const members = [
      ...this.listed(people, stableDesk),
      ...this.unlisted(people, stableDesk, results),
    ];
    const rows = members.map((m) =>
      results.map((r) => this.outputOf(m, r, members)),
    );

    const latest = weeks.length - 1;
    const groups = (Object.keys(GROUPS) as GroupKey[]).map(
      (key): ReportGroup => {
        const inGroup = members
          .map((m, i) => ({ m, weeks: rows[i] }))
          .filter(
            ({ m, weeks: w }) =>
              m.group === key && (m.rostered || w.some((t) => t.output > 0)),
          );
        const rostered = inGroup.filter((x) => x.m.rostered).map((x) => x.m);
        const sum = (wi: number, pick: (t: WeekTally) => number) =>
          inGroup.reduce((total, x) => total + pick(x.weeks[wi]), 0);
        const perDivision = new Map<string, number>();
        for (const m of rostered) {
          perDivision.set(m.division, (perDivision.get(m.division) ?? 0) + 1);
        }

        return {
          key,
          ...GROUPS[key],
          rostered: rostered.length,
          onLeave: rostered.filter((m) => awayAllWeek.has(m.name.toLowerCase()))
            .length,
          divisions: [...perDivision]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([d]) => d),
          weeks: weeks.map((_, wi) =>
            tally(
              sum(wi, (t) => t.output),
              sum(wi, (t) => t.daysWorked),
              sum(wi, (t) => t.active),
            ),
          ),
          members: inGroup
            .map(
              ({ m, weeks: w }): ReportMember => ({
                name: m.name,
                division: m.division,
                role: m.role,
                weeks: w,
              }),
            )
            .sort(
              (a, b) =>
                b.weeks[latest].output - a.weeks[latest].output ||
                a.name.localeCompare(b.name),
            ),
        };
      },
    );

    return { weeks, latestEnd, groups };
  }

  private listed(people: ResPerson[], stableDesk: SpRosterPerson[]): Member[] {
    const out: Member[] = [];
    for (const p of people) {
      for (const placed of placementsOf(p)) {
        out.push({
          name: p.name,
          division: p.primaryDivision,
          role: p.role,
          ...placed,
          rostered: !/^(inactive|exited)$/i.test(p.status),
        });
      }
    }
    // The Stable desk keeps its own roster; someone on both lists is counted once.
    const seen = new Set(out.map((m) => m.name.toLowerCase()));
    for (const s of stableDesk) {
      if (
        !['writer', 'editor'].includes(s.roleGroup) ||
        seen.has(s.name.toLowerCase())
      ) {
        continue;
      }
      out.push({
        name: s.name,
        division: 'Stables',
        role: s.position,
        group: s.roleGroup === 'writer' ? 'stables' : 'stables-editors',
        as: 'writer',
        rostered: true,
      });
    }
    return out;
  }

  /**
   * Writers with output who are on no schedule at all. Kept as a group of their
   * own rather than dropped: about a third of the desk's pieces are theirs, and
   * the list is what tells the managers who to add.
   */
  private unlisted(
    people: ResPerson[],
    stableDesk: SpRosterPerson[],
    results: CombinedProductionResult[],
  ): Member[] {
    const known = new Set(
      [...people, ...stableDesk].map((p) => p.name.toLowerCase()),
    );
    const out = new Map<string, Member>();
    for (const r of results) {
      for (const w of r.writers) {
        const key = w.writer.toLowerCase();
        if (w.writer === NO_WRITER || known.has(key) || out.has(key)) continue;
        out.set(key, {
          name: w.writer,
          division: w.division,
          role: '',
          group: 'unlisted',
          as: 'writer',
          rostered: false,
        });
      }
    }
    return [...out.values()];
  }

  /**
   * A member's output in one week. Production names people as the roster spells
   * them; two members sharing a name are told apart by division.
   */
  private outputOf(
    m: Member,
    week: CombinedProductionResult,
    all: Member[],
  ): WeekTally {
    const name = m.name.toLowerCase();
    const rows =
      m.as === 'writer'
        ? week.writers.map((w) => ({
            who: w.writer,
            division: w.division,
            n: w.submitted.total,
            days: w.daysWorked,
          }))
        : week.editors.map((e) => ({
            who: e.editor,
            division: e.division,
            n: e.published.total,
            days: e.daysWorked,
          }));
    const row = rows.find((r) => r.who.toLowerCase() === name);
    if (!row) return tally(0, 0, 0);

    const namesakes = all.filter(
      (x) => x.as === m.as && x.name.toLowerCase() === name,
    );
    if (namesakes.length > 1) {
      const owner =
        namesakes.find((x) => x.division === row.division) ?? namesakes[0];
      if (owner !== m) return tally(0, 0, 0);
    }
    const active = row.n > 0 ? 1 : 0;
    // The sheet averages editors' own writing over the whole week, not days worked.
    if (GROUPS[m.group].measure === 'written') {
      return tally(row.n, active * 7, active);
    }
    return tally(row.n, row.days ?? 0, active);
  }
}
