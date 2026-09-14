import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { CriticalFlowService } from './critical-flow.service';
import { ResourcesService } from './resources.service';
import { CfFilterParams } from './types';

@Controller('v1/critical-flow')
export class CriticalFlowController {
  constructor(
    private readonly service: CriticalFlowService,
    private readonly resources: ResourcesService,
  ) {}

  private parseFilters(query: Record<string, any>): CfFilterParams {
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
      yahoo: query.yahoo || undefined,
    };
  }

  @Get('sync-status')
  getSyncStatus() {
    return this.service.getSyncStatus();
  }

  /** ?force=true re-parses every row, backfilling a parsing-logic change. */
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

  @Get('send-backs')
  getSendBacks(@Query() query: Record<string, any>) {
    return this.service.getSendBacks(this.parseFilters(query));
  }

  @Get('tat')
  getTat(@Query() query: Record<string, any>) {
    return this.service.getTat(this.parseFilters(query));
  }

  @Get('divisions')
  getDivisions(@Query() query: Record<string, any>) {
    return this.service.getDivisions(this.parseFilters(query));
  }

  @Get('article-types')
  getArticleTypes(@Query() query: Record<string, any>) {
    return this.service.getArticleTypes(this.parseFilters(query));
  }

  @Get('yahoo-split')
  getYahooSplit(@Query() query: Record<string, any>) {
    return this.service.getYahooSplit(this.parseFilters(query));
  }

  @Get('roster')
  getRoster(@Query() query: Record<string, any>) {
    return this.service.getRoster(this.parseFilters(query));
  }

  @Get('insights')
  getInsights(@Query() query: Record<string, any>) {
    return this.service.getInsights(this.parseFilters(query));
  }

  // ── Resources page ──

  @Get('resources/summary')
  getResourceSummary(@Query('date') date?: string) {
    return this.resources.getSummary(date || undefined);
  }

  @Get('resources/board')
  getResourceBoard(@Query() query: Record<string, any>) {
    const split = (v: any): string[] | undefined => (v ? String(v).split(',') : undefined);
    return this.resources.getBoard({
      date: query.date || undefined,
      divisions: split(query.divisions),
      role: query.role || undefined,
      statuses: split(query.statuses),
      q: query.q || undefined,
    });
  }

  @Get('resources/suggest')
  suggestResources(@Query() query: Record<string, any>) {
    return this.resources.suggest({
      division: String(query.division || ''),
      role: query.role || undefined,
      forPerson: query.forPerson || undefined,
      date: query.date || undefined,
    });
  }

  @Get('resources/health')
  getResourceHealth() {
    return this.resources.getHealth();
  }

  @Get('resources/profiles')
  getResourceProfiles() {
    return this.resources.getProfiles();
  }

  @Put('resources/profiles')
  updateResourceProfiles(@Body() body: any) {
    return this.resources.updateProfiles(body);
  }
}
