import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { ReportSportsMapping } from './entities/report-sports-mapping.entity';

@Injectable()
export class ReportSportsMappingsService {
  constructor(
    @InjectRepository(ReportSportsMapping)
    private readonly mappingRepo: Repository<ReportSportsMapping>,
  ) {}

  /** Return all mappings ordered by sport then pageName. */
  async findAll(): Promise<ReportSportsMapping[]> {
    return this.mappingRepo.find({ order: { sport: 'ASC', pageName: 'ASC' } });
  }

  /** Upsert a mapping row for a given profileId (idempotent). */
  async upsert(profileId: string, pageName: string, sport: string | null): Promise<ReportSportsMapping> {
    const normalizedSport = (typeof sport === 'string' && sport.trim()) ? sport.trim() : null;

    let existing = await this.mappingRepo.findOneBy({ profileId });

    if (existing) {
      existing.pageName = pageName;
      existing.sport = normalizedSport;
      return this.mappingRepo.save(existing);
    }

    const newMapping = this.mappingRepo.create({
      profileId,
      pageName,
      sport: normalizedSport,
    });
    return this.mappingRepo.save(newMapping);
  }

  /** Update the sport field for a single mapping by ID. */
  async updateSport(id: number, sport: string | null): Promise<ReportSportsMapping[]> {
    const normalizedSport = (typeof sport === 'string' && sport.trim()) ? sport.trim() : null;
    await this.mappingRepo.update(id, { sport: normalizedSport });
    return this.findAll();
  }

  /** Batch-update the sport field for multiple IDs at once. */
  async batchUpdateSport(ids: number[], sport: string | null): Promise<ReportSportsMapping[]> {
    const normalizedSport = (typeof sport === 'string' && sport.trim()) ? sport.trim() : null;

    if (ids.length > 0) {
      await this.mappingRepo
        .createQueryBuilder()
        .update()
        .set({ sport: normalizedSport })
        .where({ id: In(ids) })
        .execute();
    }

    return this.findAll();
  }

  /** Ensure all active social profiles have a mapping row.
   *  Called lazily from the controller to auto-populate from the profiles list. */
  async syncFromProfiles(profiles: { profileId: string; name: string }[]): Promise<void> {
    const existing = await this.mappingRepo.find({ select: ['profileId'] });
    const existingIds = new Set(existing.map((m) => m.profileId));

    const newMappings: Partial<ReportSportsMapping>[] = [];
    for (const p of profiles) {
      if (!existingIds.has(p.profileId)) {
        newMappings.push({
          profileId: p.profileId,
          pageName: p.name,
          sport: null,
        });
      }
    }

    if (newMappings.length > 0) {
      await this.mappingRepo.save(newMappings);
    }
  }
}
