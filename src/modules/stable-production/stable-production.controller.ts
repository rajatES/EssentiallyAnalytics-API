import { Controller, Get, Post, Query } from '@nestjs/common';
import { StableProductionService } from './stable-production.service';
import { StableFilterParams } from './types';
import { MinRole } from '../../common/decorators/min-role.decorator';
import { UserRole } from '../auth/entities/user.entity';

@Controller('v1/stable-production')
export class StableProductionController {
  constructor(private readonly service: StableProductionService) {}

  private parseFilters(query: Record<string, any>): StableFilterParams {
    const split = (v: any): string[] | undefined =>
      v ? String(v).split(',') : undefined;
    return {
      events: split(query.events),
      sports: split(query.sports),
      writers: split(query.writers),
      editors: split(query.editors),
      stableTypes: split(query.stableTypes),
      stages: split(query.stages),
      kinds: split(query.kinds),
    };
  }

  @Get('sync-status')
  getSyncStatus() {
    return this.service.getSyncStatus();
  }

  /** ?force=true rewrites every row, backfilling a parsing change. */
  @MinRole(UserRole.ADMIN)
  @Post('sync')
  async triggerSync(@Query('force') force?: string) {
    await this.service.syncData(force === 'true');
    return this.service.getSyncStatus();
  }

  @Get('filters')
  getFilters() {
    return this.service.getFilterOptions();
  }

  @Get('overview')
  getOverview(@Query() query: Record<string, any>) {
    return this.service.getOverview(this.parseFilters(query));
  }

  @Get('events')
  getEvents(@Query() query: Record<string, any>) {
    return this.service.getEvents(this.parseFilters(query));
  }

  @Get('writers')
  getWriters(@Query() query: Record<string, any>) {
    return this.service.getWriters(this.parseFilters(query));
  }

  @Get('editors')
  getEditors(@Query() query: Record<string, any>) {
    return this.service.getEditors(this.parseFilters(query));
  }

  @Get('stable-types')
  getStableTypes(@Query() query: Record<string, any>) {
    return this.service.getStableTypes(this.parseFilters(query));
  }

  @Get('queue')
  getQueue(@Query() query: Record<string, any>) {
    return this.service.getQueue(this.parseFilters(query));
  }

  @Get('roster')
  getRoster(@Query() query: Record<string, any>) {
    return this.service.getRoster(this.parseFilters(query));
  }

  @Get('quality')
  getQuality(@Query() query: Record<string, any>) {
    return this.service.getQuality(this.parseFilters(query));
  }
}
