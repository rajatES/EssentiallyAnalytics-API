import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { round } from '../production/analytics';
import { isPersonName } from '../production/name-resolver';
import { shiftDate, todayIst } from '../production/time';
import {
  CombinedProductionResult,
  CombinedProductionService,
  NO_WRITER,
} from '../resources/combined-production.service';
import { ResPerson } from '../resources/entities/res-person.entity';
import {
  GroupKey,
  ReportGroup,
  ReportMember,
  ReportWeek,
  WeekTally,
  WeeklyReport,
} from './types';

const DEFAULT_WEEKS = 4;
const MAX_WEEKS = 8;

/**
 * The groups and targets of the desk's Week on Week sheet, in its order.
 * Targets are its "ideal efficiency": output per person per day worked.
 */
const GROUPS: Record<
  GroupKey,
  { name: string; target: number | null; measure: ReportGroup['measure'] }
> = {
  stables: { name: 'Stables writers', target: 4, measure: 'submitted' },
  'part-time': { name: 'Part-time writers', target: 4, measure: 'submitted' },
  tenured: { name: 'Tenured writers', target: 5, measure: 'submitted' },
  editors: { name: 'Editors', target: 15, measure: 'published' },
  'associate-editors': {
    name: 'Associate editors',
    target: null,
    measure: 'published',
  },
  newsroom: { name: 'Newsroom editors', target: null, measure: 'published' },
  producers: { name: 'Producers', target: 5, measure: 'submitted' },
  associates: { name: 'Associates', target: null, measure: 'written' },
  pod: { name: 'Pod', target: null, measure: 'written' },
  'non-pod': { name: 'Non-pod', target: null, measure: 'written' },
  unlisted: {
    name: 'Not on Team Structure',
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

/**
 * Where a person on Team Structure belongs, read from the columns the managers
 * keep: Role / Designation, FT/PT, Pod/Non-Pod and Sports / Vertical.
 *
 * - Writers: Stables, then part-time by FT/PT, the rest tenured.
 * - Producers: by what they write.
 * - Editors publish (the Editors block: non-pod desks, associates and the
 *   newsroom each on their own, so the newsroom's Yahoo publishing does not
 *   drag the desk editors' average), and their own writing is the Pod /
 *   Non-pod / Associates block. "NL Editor" counts: on the pod desks it is the
 *   editor's title.
 * - Leads, and anyone on another team (Newsletter), are outside the report.
 */
function placementsOf(p: ResPerson): Placement[] {
  const stables = /^stables$/i.test(p.pod) || p.primaryDivision === 'Stables';
  if (/writer/i.test(p.role) || (stables && /producer/i.test(p.role))) {
    const group: GroupKey = stables
      ? 'stables'
      : /part/i.test(p.status)
        ? 'part-time'
        : 'tenured';
    return [{ group, as: 'writer' }];
  }
  if (/producer/i.test(p.role)) return [{ group: 'producers', as: 'writer' }];
  if (p.roleGroup !== 'editor') return [];
  if (p.primaryDivision === 'Newsroom')
    return [{ group: 'newsroom', as: 'editor' }];
  if (p.primaryDivision === 'Associate') {
    return [
      { group: 'associate-editors', as: 'editor' },
      { group: 'associates', as: 'writer' },
    ];
  }
  if (/^pod$/i.test(p.pod)) return [{ group: 'pod', as: 'writer' }];
  return [
    { group: 'editors', as: 'editor' },
    { group: 'non-pod', as: 'writer' },
  ];
}

const tally = (output: number, daysWorked: number): WeekTally => ({
  output,
  daysWorked,
  active: output > 0 ? 1 : 0,
  perDay: output > 0 && daysWorked > 0 ? round(output / daysWorked, 2) : null,
});

/** The group's figure: each active member's own rate, averaged. */
function groupTally(members: WeekTally[]): WeekTally {
  const active = members.filter((t) => t.output > 0 && t.perDay != null);
  const output = members.reduce((n, t) => n + t.output, 0);
  return {
    output,
    daysWorked: members.reduce((n, t) => n + t.daysWorked, 0),
    active: active.length,
    perDay: active.length
      ? round(
          active.reduce((n, t) => n + (t.perDay as number), 0) / active.length,
          2,
        )
      : null,
  };
}

@Injectable()
export class WeeklyReportService {
  constructor(
    private readonly production: CombinedProductionService,
    @InjectRepository(ResPerson)
    private readonly peopleRepo: Repository<ResPerson>,
  ) {}

  /**
   * `weeks` weeks ending with the one `end` falls in. The week in progress can
   * be shown, counted up to today; by default the report ends on the latest
   * complete week.
   */
  async getReport(end?: string, weeks?: number): Promise<WeeklyReport> {
    const today = todayIst();
    const latestEnd = weekEndOf(today);
    const lastCompleteEnd = shiftDate(latestEnd, -7);
    const count = Math.min(
      Math.max(Math.round(weeks || DEFAULT_WEEKS), 1),
      MAX_WEEKS,
    );
    const asked =
      end && /^\d{4}-\d{2}-\d{2}$/.test(end) ? weekEndOf(end) : lastCompleteEnd;
    const finalEnd = asked > latestEnd ? latestEnd : asked;
    const shown: ReportWeek[] = Array.from({ length: count }, (_, i) => {
      const weekEnd = shiftDate(finalEnd, -7 * (count - 1 - i));
      const partial = weekEnd > today;
      return {
        start: shiftDate(weekEnd, -6),
        end: weekEnd,
        partial,
        through: partial ? today : weekEnd,
      };
    });

    const [people, results] = await Promise.all([
      this.peopleRepo.find(),
      Promise.all(
        shown.map((w) =>
          this.production.get({ startDate: w.start, endDate: w.through }),
        ),
      ),
    ]);

    const members = [
      ...this.listed(people, results),
      ...this.unlisted(people, results),
    ];
    const rows = members.map((m) => results.map((r) => this.outputOf(m, r)));

    const latest = shown.length - 1;
    const groups = (Object.keys(GROUPS) as GroupKey[]).map(
      (key): ReportGroup => {
        const inGroup = members
          .map((m, i) => ({ m, weeks: rows[i] }))
          .filter(
            ({ m, weeks: w }) =>
              m.group === key && (m.rostered || w.some((t) => t.output > 0)),
          );
        const rostered = inGroup.filter((x) => x.m.rostered).map((x) => x.m);
        const perDivision = new Map<string, number>();
        for (const m of rostered)
          perDivision.set(m.division, (perDivision.get(m.division) ?? 0) + 1);

        return {
          key,
          ...GROUPS[key],
          rostered: rostered.length,
          divisions: [...perDivision]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([d]) => d),
          weeks: shown.map((_, wi) =>
            groupTally(inGroup.map((x) => x.weeks[wi])),
          ),
          members: inGroup
            .map(
              ({ m, weeks: w }): ReportMember => ({
                name: m.name,
                division: m.division,
                role: m.role,
                rostered: m.rostered,
                weeks: w,
              }),
            )
            .sort(
              (a, b) =>
                (b.weeks[latest].perDay ?? -1) -
                  (a.weeks[latest].perDay ?? -1) ||
                b.weeks[latest].output - a.weeks[latest].output ||
                a.name.localeCompare(b.name),
            ),
        };
      },
    );

    return { weeks: shown, latestEnd, lastCompleteEnd, groups };
  }

  /**
   * The Critical Flow team as Team Structure lists it. Someone in a vertical
   * with no CF or Yahoo content (NetflixJunkie, ES Daily) only shows when the
   * content names them, and is not counted in the group's roster size.
   */
  private listed(
    people: ResPerson[],
    results: CombinedProductionResult[],
  ): Member[] {
    const out: Member[] = [];
    for (const p of people) {
      if (p.team !== 'Critical Flow' || /^(inactive|exited)$/i.test(p.status))
        continue;
      const offDesk = p.flags.split(',').includes('off-desk');
      if (offDesk && !results.some((r) => this.hasOutput(r, p.name))) continue;
      for (const placed of placementsOf(p)) {
        out.push({
          name: p.name,
          division: p.primaryDivision,
          role: p.role,
          ...placed,
          rostered: !offDesk,
        });
      }
    }
    return out;
  }

  private hasOutput(r: CombinedProductionResult, name: string): boolean {
    const n = name.toLowerCase();
    return (
      r.writers.some((w) => w.writer.toLowerCase() === n) ||
      r.editors.some((e) => e.editor.toLowerCase() === n)
    );
  }

  /**
   * Writers with output under a name nobody on Team Structure has, on any
   * team. Kept as a group of their own rather than dropped: the list is what
   * tells the managers who to add, or which spelling to fix.
   */
  private unlisted(
    people: ResPerson[],
    results: CombinedProductionResult[],
  ): Member[] {
    const known = new Set(people.map((p) => p.name.toLowerCase()));
    const out = new Map<string, Member>();
    for (const r of results) {
      for (const w of r.writers) {
        const key = w.writer.toLowerCase();
        if (
          w.writer === NO_WRITER ||
          !isPersonName(w.writer) ||
          known.has(key) ||
          out.has(key)
        )
          continue;
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

  /** A member's output in one week. Production names people as the roster spells them. */
  private outputOf(m: Member, week: CombinedProductionResult): WeekTally {
    const name = m.name.toLowerCase();
    if (m.as === 'writer') {
      const w = week.writers.find((x) => x.writer.toLowerCase() === name);
      return w ? tally(w.submitted.total, w.daysWorked ?? 0) : tally(0, 0);
    }
    const e = week.editors.find((x) => x.editor.toLowerCase() === name);
    return e ? tally(e.published.total, e.daysWorked ?? 0) : tally(0, 0);
  }
}
