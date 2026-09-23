import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RosterPerson } from '../production/production-piece';
import { ResPerson } from './entities/res-person.entity';
import { ResProfile } from './entities/res-profile.entity';
import { FLOAT_POOLS, canonicalDivision, coversLabel } from './divisions';

/**
 * The people list, handed to each production pipeline as its roster.
 *
 * Critical Flow and Yahoo label divisions differently ("College Football" vs
 * "CFB", "US Sports" vs "Tennis"), so each pipeline asks with its own labels
 * and gets people placed under them — which is what its name resolver and
 * roster board are keyed on.
 */
@Injectable()
export class ResourceDirectoryService {
  constructor(
    @InjectRepository(ResPerson) private readonly peopleRepo: Repository<ResPerson>,
    @InjectRepository(ResProfile) private readonly profileRepo: Repository<ResProfile>,
  ) {}

  count(): Promise<number> {
    return this.peopleRepo.count();
  }

  /**
   * People working in any of `labels`, plus the floating pools (Associates,
   * the newsroom) listed once under their pool name. People who have left are
   * not on anyone's roster.
   */
  async rosterFor(labels: string[]): Promise<RosterPerson[]> {
    const [people, profiles] = await Promise.all([this.peopleRepo.find(), this.profileRepo.find()]);
    const quota = new Map(profiles.map((p) => [p.id, p.dailyQuota]));
    const out: RosterPerson[] = [];

    for (const p of people) {
      if (/exited/i.test(p.status)) continue;
      const base = {
        name: p.name,
        role: p.role,
        roleGroup: p.roleGroup,
        weekoff: p.weekoff,
        shift: p.shiftClock || p.shift,
        email: '',
        dailyTarget: quota.get(`${p.primaryDivision}|${p.name}`) ?? null,
      };
      if (FLOAT_POOLS.has(p.primaryDivision)) {
        out.push({ ...base, id: p.id, division: p.primaryDivision, floats: true });
        continue;
      }
      // Once per person, or head counts double: Yahoo files a stray piece
      // under "Boxing", which is UFC too. An exact label wins, then one with the
      // person's own sub-feed ("Olympics"), then any that covers them.
      const home = { division: p.primaryDivision, subFeed: p.subFeed };
      const covering = labels.filter((l) => coversLabel(home, l));
      const label =
        covering.find((l) => l === p.primaryDivision) ??
        covering.find((l) => !!p.subFeed && canonicalDivision(l).subFeed === p.subFeed) ??
        covering[0];
      if (label) out.push({ ...base, id: p.id, division: label });
    }
    return out;
  }
}
