import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Put,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { MsnProductionService } from './msn-production.service';
import { ReportsService } from './reports.service';
import { Public } from '../../common/decorators/public.decorator';
import { MsnFilterParams } from './types';

@Controller('v1/msn-production')
export class MsnProductionController {
  constructor(
    private readonly service: MsnProductionService,
    private readonly reports: ReportsService,
  ) {}

  private parseFilters(query: Record<string, any>): MsnFilterParams {
    const split = (v: any): string[] | undefined =>
      v ? v.split(',') : undefined;
    return {
      startDate: query.startDate || undefined,
      endDate: query.endDate || undefined,
      categories: split(query.categories),
      feeds: split(query.feeds),
      writers: split(query.writers),
      editors: split(query.editors),
      contentTypes: split(query.contentTypes),
      statuses: split(query.statuses),
      allotters: split(query.allotters),
    };
  }

  @Get('sync-status')
  async getSyncStatus() {
    return this.service.getSyncStatus();
  }

  @Post('sync')
  async triggerSync() {
    await this.service.syncData();
    return this.service.getSyncStatus();
  }

  @Get('filters')
  async getFilters() {
    return this.service.getFilterOptions();
  }

  @Get('overview')
  getOverview(@Query() query: Record<string, any>) {
    return this.service.getOverview(this.parseFilters(query));
  }

  @Get('timeseries')
  getTimeseries(@Query() query: Record<string, any>) {
    return this.service.getTimeseries(
      this.parseFilters(query),
      query.granularity || 'day',
    );
  }

  @Get('funnel')
  getFunnel(@Query() query: Record<string, any>) {
    return this.service.getFunnel(this.parseFilters(query));
  }

  @Get('status-mix')
  getStatusMix(@Query() query: Record<string, any>) {
    return this.service.getStatusMix(this.parseFilters(query));
  }

  @Get('feeds')
  getFeedStats(@Query() query: Record<string, any>) {
    return this.service.getFeedStats(this.parseFilters(query));
  }

  @Get('writers')
  getWriterStats(@Query() query: Record<string, any>) {
    return this.service.getWriterStats(this.parseFilters(query));
  }

  @Get('editors')
  getEditorStats(@Query() query: Record<string, any>) {
    return this.service.getEditorStats(this.parseFilters(query));
  }

  @Get('allotters')
  getAllotterStats(@Query() query: Record<string, any>) {
    return this.service.getAllotterStats(this.parseFilters(query));
  }

  @Get('production')
  getProduction(@Query() query: Record<string, any>) {
    return this.service.getProduction(this.parseFilters(query));
  }

  @Get('content-mix')
  getContentMix(@Query() query: Record<string, any>) {
    return this.service.getContentMix(
      this.parseFilters(query),
      query.granularity || 'week',
    );
  }

  @Get('heatmap')
  getHeatmap(@Query() query: Record<string, any>) {
    return this.service.getHeatmap(
      this.parseFilters(query),
      query.type || 'calendar',
    );
  }

  @Get('writer-daily')
  getWriterDailyBreakdown(@Query() query: Record<string, any>) {
    return this.service.getWriterDailyBreakdown(this.parseFilters(query));
  }

  @Get('editor-daily')
  getEditorDailyBreakdown(@Query() query: Record<string, any>) {
    return this.service.getEditorDailyBreakdown(this.parseFilters(query));
  }

  @Get('stage-durations')
  getStageDurations(@Query() query: Record<string, any>) {
    return this.service.getStageDurations(this.parseFilters(query));
  }

  @Get('leakage')
  getLeakage(@Query() query: Record<string, any>) {
    return this.service.getLeakage(this.parseFilters(query));
  }

  @Get('repeating-titles')
  getRepeatingTitles(@Query() query: Record<string, any>) {
    return this.service.getRepeatingTitles(this.parseFilters(query));
  }

  @Get('stage-board')
  getStageBoard(@Query() query: Record<string, any>) {
    return this.service.getStageBoard(this.parseFilters(query));
  }

  @Get('people-availability')
  getPeopleAvailability() {
    return this.service.getPeopleAvailability();
  }

  @Get('category-split')
  getCategorySplit(@Query() query: Record<string, any>) {
    return this.service.getCategorySplit(this.parseFilters(query));
  }

  @Get('insights')
  getInsights(@Query() query: Record<string, any>) {
    return this.service.getInsights(this.parseFilters(query));
  }

  @Get('moderation')
  getModeration(@Query() query: Record<string, any>) {
    return this.service.getModeration(this.parseFilters(query));
  }

  @Get('duplicates')
  getDuplicates(@Query() query: Record<string, any>) {
    return this.service.getDuplicates(this.parseFilters(query));
  }

  // ── Syndication reports (EOD / EOW / MTD) ──

  /**
   * Scraper ingest endpoint. Public (the scraper has no user cookie) but
   * protected by a shared secret sent as the X-Ingest-Key header.
   */
  @Public()
  @Post('reports/ingest')
  ingestReport(
    @Headers('x-ingest-key') ingestKey: string | undefined,
    @Body() body: any,
  ) {
    const expected = process.env.MSN_INGEST_KEY;
    if (!expected) {
      // Refuse rather than silently accept everything when unconfigured.
      throw new UnauthorizedException('Ingest is not configured on the server');
    }
    if (ingestKey !== expected) {
      throw new UnauthorizedException('Invalid ingest key');
    }
    return this.reports.ingest(body);
  }

  @Get('reports/config')
  getReportsConfig() {
    return this.reports.getConfig();
  }

  @Get('reports/targets')
  getReportTargets() {
    return this.reports.getTargets();
  }

  @Put('reports/targets')
  updateReportTargets(@Body() body: any) {
    return this.reports.updateTargets(body);
  }

  @Get('reports/periods')
  getReportPeriods() {
    return this.reports.getPeriods();
  }

  @Get('reports/eod')
  getEodReport(@Query('date') date?: string) {
    return this.reports.getEod(date || undefined);
  }

  @Get('reports/eow')
  getEowReport(@Query('weekStart') weekStart?: string) {
    return this.reports.getEow(weekStart || undefined);
  }

  @Get('reports/mtd')
  getMtdReport(@Query('month') month?: string) {
    return this.reports.getMtd(month || undefined);
  }
}
