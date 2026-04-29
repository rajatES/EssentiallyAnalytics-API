import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DailyRevenue } from './entities/daily-revenue.entity';
import { RevenueMapping } from './entities/revenue-mapping.entity';

@Injectable()
export class RevenueService {
    constructor(
        @InjectRepository(DailyRevenue)
        private dailyRevenueRepo: Repository<DailyRevenue>,
        @InjectRepository(RevenueMapping)
        private mappingRepo: Repository<RevenueMapping>,
    ) { }

    // ---- MAPPINGS API ----
    async getMappings() {
        return this.mappingRepo.find({ order: { team: 'ASC', pageName: 'ASC' } });
    }

    async updateMappingTeam(id: number, team: string | null) {
        const normalizedTeam = (typeof team === 'string' && team.trim()) ? team.trim() : 'Unassigned';
        
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