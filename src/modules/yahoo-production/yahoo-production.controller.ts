import { Controller, Get, Post, Query } from '@nestjs/common';
import { YahooProductionService } from './yahoo-production.service';
import { YpFilterParams } from './types';
import { MinRole } from '../../common/decorators/min-role.decorator';
import { UserRole } from '../auth/entities/user.entity';
import { Section } from '../../common/decorators/section.decorator';

@Controller('v1/yahoo-production')
@Section('cf')
export class YahooProductionController {
  constructor(private readonly service: YahooProductionService) {}

  private parseFilters(query: Record<string, any>): YpFilterParams {
    const split = (v: any): string[] | undefined => (v ? String(v).split(',') : undefined);
    return {
      startDate: query.startDate || undefined,
      endDate: query.endDate || undefined,
      divisions: split(query.divisions),
      writers: split(query.writers),
      editors: split(query.editors),
      articleTypes: split(query.articleTypes),
      statuses: split(query.statuses),
      allotters: split(query.allotters),
    };
  }

  @Get('sync-status')
  getSyncStatus() {
    return this.service.getSyncStatus();
  }

  /** ?force=true re-parses every row, backfilling a parsing-logic change. */
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

  @Get('timeseries')
  getTimeseries(@Query() query: Record<string, any>) {
    return this.service.getTimeseries(this.parseFilters(query), query.granularity || 'day');
  }

  @Get('funnel')
  getFunnel(@Query() query: Record<string, any>) {
    return this.service.getFunnel(this.parseFilters(query));
  }

  @Get('pending')
  getPending(@Query() query: Record<string, any>) {
    return this.service.getPending(this.parseFilters(query));
  }

  @Get('writers')
  getWriters(@Query() query: Record<string, any>) {
    return this.service.getWriterStats(this.parseFilters(query));
  }

  @Get('editors')
  getEditors(@Query() query: Record<string, any>) {
    return this.service.getEditorStats(this.parseFilters(query));
  }

  @Get('allotters')
  getAllotters(@Query() query: Record<string, any>) {
    return this.service.getAllotterStats(this.parseFilters(query));
  }

  @Get('tat')
  getTat(@Query() query: Record<string, any>) {
    return this.service.getTat(this.parseFilters(query));
  }

  @Get('divisions')
  getDivisions(@Query() query: Record<string, any>) {
    return this.service.getDivisions(this.parseFilters(query));
  }

  @Get('quotas')
  getQuotas(@Query() query: Record<string, any>) {
    return this.service.getQuotaAttainment(this.parseFilters(query));
  }

  @Get('article-types')
  getArticleTypes(@Query() query: Record<string, any>) {
    return this.service.getArticleTypes(this.parseFilters(query));
  }

  @Get('roster')
  getRoster(@Query() query: Record<string, any>) {
    return this.service.getRoster(this.parseFilters(query));
  }

  @Get('insights')
  getInsights(@Query() query: Record<string, any>) {
    return this.service.getInsights(this.parseFilters(query));
  }
}
