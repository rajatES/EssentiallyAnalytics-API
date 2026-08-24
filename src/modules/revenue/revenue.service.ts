import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DailyRevenue } from './entities/daily-revenue.entity';
import { RevenueMapping } from './entities/revenue-mapping.entity';
import {
  buildHeadlineWindows,
  windowResult,
} from '../../common/headline-windows';

@Injectable()
export class RevenueService {
  constructor(
    @InjectRepository(DailyRevenue)
    private dailyRevenueRepo: Repository<DailyRevenue>,
    @InjectRepository(RevenueMapping)
    private mappingRepo: Repository<RevenueMapping>,
  ) {}

  // ---- MAPPINGS API ----
  async getMappings() {
    return this.mappingRepo.find({ order: { team: 'ASC', pageName: 'ASC' } });
  }

  async updateMappingTeam(id: number, team: string | null) {
    const normalizedTeam =
      typeof team === 'string' && team.trim() ? team.trim() : 'Unassigned';

    await this.mappingRepo.update(id, { team: normalizedTeam });

    const row = await this.mappingRepo.findOneBy({ id });
    if (row) {
      await this.mappingRepo
        .createQueryBuilder()
        .update()
        .set({ team: normalizedTeam })
        .where('"pageName" = :pageName', { pageName: row.pageName })
        .execute();
    }

    return this.getMappings();
  }

  // ---- FRONTEND DASHBOARD API ----
  /**
   * MTD / DOD / WOW revenue windows, each with the span it compares against.
   *
   * Anchored on the newest day with revenue rather than yesterday, since the
   * Meta revenue feed lands a day or more late.
   */
  async getHeadlineWindows() {
    const anchorRow = await this.dailyRevenueRepo
      .createQueryBuilder('dr')
      .select(`MAX(TO_CHAR(dr.date, 'YYYY-MM-DD'))`, 'latest')
      .where('dr."totalRevenue" > 0')
      .getRawOne<{ latest: string | null }>();

    const windows = buildHeadlineWindows(
      anchorRow?.latest ||
        new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    );

    const span = (name: string) => [
      `COALESCE(SUM(CASE WHEN dr.date >= :${name}Start AND dr.date <= :${name}End THEN dr."totalRevenue" ELSE 0 END), 0) as ${name}_value`,
      `COALESCE(SUM(CASE WHEN dr.date >= :${name}PrevStart AND dr.date <= :${name}PrevEnd THEN dr."totalRevenue" ELSE 0 END), 0) as ${name}_prev`,
    ];

    const row = await this.dailyRevenueRepo
      .createQueryBuilder('dr')
      .select([...span('dod'), ...span('wow'), ...span('mtd')])
      .where('dr.date >= :earliest AND dr.date <= :latest', {
        earliest: windows.earliest,
        latest: windows.anchor,
      })
      .setParameters({
        dodStart: windows.dod.start,
        dodEnd: windows.dod.end,
        dodPrevStart: windows.dod.prevStart,
        dodPrevEnd: windows.dod.prevEnd,
        wowStart: windows.wow.start,
        wowEnd: windows.wow.end,
        wowPrevStart: windows.wow.prevStart,
        wowPrevEnd: windows.wow.prevEnd,
        mtdStart: windows.mtd.start,
        mtdEnd: windows.mtd.end,
        mtdPrevStart: windows.mtd.prevStart,
        mtdPrevEnd: windows.mtd.prevEnd,
      })
      .getRawOne<Record<string, string>>();

    const num = (key: string) => Number(row?.[key] || 0);

    return {
      anchorDate: windows.anchor,
      metric: 'revenue',
      mtd: windowResult(windows.mtd, num('mtd_value'), num('mtd_prev')),
      dod: windowResult(windows.dod, num('dod_value'), num('dod_prev')),
      wow: windowResult(windows.wow, num('wow_value'), num('wow_prev')),
    };
  }

  async getAggregatedMetrics(startDate: string, endDate: string) {
    return this.dailyRevenueRepo
      .createQueryBuilder('dr')
      .select([
        'dr.date AS "date"',
        'rm.pageName AS "pageName"',
        'rm.team AS "team"',
        'SUM(dr.bonusRevenue) AS "bonus"',
        'SUM(dr.photoRevenue) AS "photo"',
        'SUM(dr.reelRevenue) AS "reel"',
        'SUM(dr.storyRevenue) AS "story"',
        'SUM(dr.textRevenue) AS "text"',
        'SUM(dr.totalRevenue) AS "total"',
      ])
      .innerJoin(RevenueMapping, 'rm', 'rm.pageId = dr.pageId')
      .where('dr.date >= :startDate', { startDate })
      .andWhere('dr.date <= :endDate', { endDate })
      .groupBy('dr.date, rm.pageName, rm.team')
      .orderBy('dr.date', 'DESC')
      .getRawMany();
  }
}
