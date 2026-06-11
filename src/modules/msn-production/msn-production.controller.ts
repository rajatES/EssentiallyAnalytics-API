import { Controller, Get, Post, Query } from '@nestjs/common';
import { MsnProductionService } from './msn-production.service';
import { MsnFilterParams } from './types';

@Controller('v1/msn-production')
export class MsnProductionController {
  constructor(private readonly service: MsnProductionService) {}

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
}
