import { Controller, Get, Patch, Post, Body, Param } from '@nestjs/common';
import { ReportSportsMappingsService } from './report-sports-mappings.service';

@Controller('v1/report-sports-mappings')
export class ReportSportsMappingsController {
  constructor(private readonly service: ReportSportsMappingsService) {}

  /** GET /v1/report-sports-mappings — list all mappings */
  @Get()
  async findAll() {
    return this.service.findAll();
  }

  /** POST /v1/report-sports-mappings/sync — populate mappings from active profiles list.
   *  Body: { profiles: { profileId: string; name: string }[] }
   */
  @Post('sync')
  async syncProfiles(@Body() body: { profiles: { profileId: string; name: string }[] }) {
    await this.service.syncFromProfiles(body.profiles || []);
    return this.service.findAll();
  }

  /**
   * PATCH /v1/report-sports-mappings/batch/sport — batch-update sport for multiple IDs.
   * Body: { ids: number[], sport: string | null }
   *
   * MUST be declared BEFORE the :id route so NestJS matches the literal
   * path segment "batch" rather than treating it as a numeric :id param.
   */
  @Patch('batch/sport')
  async batchUpdateSport(@Body() body: { ids: number[]; sport: string | null }) {
    const { ids, sport } = body;
    if (!Array.isArray(ids) || ids.length === 0) return this.service.findAll();
    return this.service.batchUpdateSport(ids, sport);
  }

  /** PATCH /v1/report-sports-mappings/:id — update sport for a single mapping */
  @Patch(':id')
  async updateSport(@Param('id') id: string, @Body() body: { sport: string | null }) {
    return this.service.updateSport(Number(id), body.sport);
  }
}
