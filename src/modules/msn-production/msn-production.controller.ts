import { Controller, Get, Post, Query } from '@nestjs/common';
import { MsnProductionService } from './msn-production.service';
import { MsnFilterParams } from './types';

@Controller('v1/msn-production')
export class MsnProductionController {
  constructor(private readonly service: MsnProductionService) {}

  private parseFilters(query: Record<string, any>): MsnFilterParams {
    return {
      startDate: query.startDate || undefined,
      endDate: query.endDate || undefined,
      brands: query.brands ? query.brands.split(',') : undefined,
      feeds: query.feeds ? query.feeds.split(',') : undefined,
      writers: query.writers ? query.writers.split(',') : undefined,
      editors: query.editors ? query.editors.split(',') : undefined,
      contentTypes: query.contentTypes
        ? query.contentTypes.split(',')
        : undefined,
      statuses: query.statuses ? query.statuses.split(',') : undefined,
      allotters: query.allotters ? query.allotters.split(',') : undefined,
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
  getOverview(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('brands') brands: string,
    @Query('feeds') feeds: string,
    @Query('writers') writers: string,
    @Query('editors') editors: string,
    @Query('contentTypes') contentTypes: string,
    @Query('statuses') statuses: string,
    @Query('allotters') allotters: string,
  ) {
    return this.service.getOverview(
      this.parseFilters({
        startDate,
        endDate,
        brands,
        feeds,
        writers,
        editors,
        contentTypes,
        statuses,
        allotters,
      }),
    );
  }

  @Get('timeseries')
  getTimeseries(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('granularity') granularity: string,
    @Query('brands') brands: string,
    @Query('feeds') feeds: string,
    @Query('writers') writers: string,
    @Query('editors') editors: string,
    @Query('contentTypes') contentTypes: string,
    @Query('statuses') statuses: string,
    @Query('allotters') allotters: string,
  ) {
    return this.service.getTimeseries(
      this.parseFilters({
        startDate,
        endDate,
        brands,
        feeds,
        writers,
        editors,
        contentTypes,
        statuses,
        allotters,
      }),
      granularity || 'day',
    );
  }

  @Get('funnel')
  getFunnel(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('brands') brands: string,
    @Query('feeds') feeds: string,
    @Query('writers') writers: string,
    @Query('editors') editors: string,
    @Query('contentTypes') contentTypes: string,
    @Query('statuses') statuses: string,
    @Query('allotters') allotters: string,
  ) {
    return this.service.getFunnel(
      this.parseFilters({
        startDate,
        endDate,
        brands,
        feeds,
        writers,
        editors,
        contentTypes,
        statuses,
        allotters,
      }),
    );
  }

  @Get('status-mix')
  getStatusMix(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('brands') brands: string,
    @Query('feeds') feeds: string,
    @Query('writers') writers: string,
    @Query('editors') editors: string,
    @Query('contentTypes') contentTypes: string,
    @Query('statuses') statuses: string,
    @Query('allotters') allotters: string,
  ) {
    return this.service.getStatusMix(
      this.parseFilters({
        startDate,
        endDate,
        brands,
        feeds,
        writers,
        editors,
        contentTypes,
        statuses,
        allotters,
      }),
    );
  }

  @Get('feeds')
  getFeedStats(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('brands') brands: string,
    @Query('feeds') feeds: string,
    @Query('writers') writers: string,
    @Query('editors') editors: string,
    @Query('contentTypes') contentTypes: string,
    @Query('statuses') statuses: string,
    @Query('allotters') allotters: string,
  ) {
    return this.service.getFeedStats(
      this.parseFilters({
        startDate,
        endDate,
        brands,
        feeds,
        writers,
        editors,
        contentTypes,
        statuses,
        allotters,
      }),
    );
  }

  @Get('writers')
  getWriterStats(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('brands') brands: string,
    @Query('feeds') feeds: string,
    @Query('writers') writers: string,
    @Query('editors') editors: string,
    @Query('contentTypes') contentTypes: string,
    @Query('statuses') statuses: string,
    @Query('allotters') allotters: string,
  ) {
    return this.service.getWriterStats(
      this.parseFilters({
        startDate,
        endDate,
        brands,
        feeds,
        writers,
        editors,
        contentTypes,
        statuses,
        allotters,
      }),
    );
  }

  @Get('editors')
  getEditorStats(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('brands') brands: string,
    @Query('feeds') feeds: string,
    @Query('writers') writers: string,
    @Query('editors') editors: string,
    @Query('contentTypes') contentTypes: string,
    @Query('statuses') statuses: string,
    @Query('allotters') allotters: string,
  ) {
    return this.service.getEditorStats(
      this.parseFilters({
        startDate,
        endDate,
        brands,
        feeds,
        writers,
        editors,
        contentTypes,
        statuses,
        allotters,
      }),
    );
  }

  @Get('allotters')
  getAllotterStats(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('brands') brands: string,
    @Query('feeds') feeds: string,
    @Query('writers') writers: string,
    @Query('editors') editors: string,
    @Query('contentTypes') contentTypes: string,
    @Query('statuses') statuses: string,
    @Query('allotters') allotters: string,
  ) {
    return this.service.getAllotterStats(
      this.parseFilters({
        startDate,
        endDate,
        brands,
        feeds,
        writers,
        editors,
        contentTypes,
        statuses,
        allotters,
      }),
    );
  }

  @Get('content-mix')
  getContentMix(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('granularity') granularity: string,
    @Query('brands') brands: string,
    @Query('feeds') feeds: string,
    @Query('writers') writers: string,
    @Query('editors') editors: string,
    @Query('contentTypes') contentTypes: string,
    @Query('statuses') statuses: string,
    @Query('allotters') allotters: string,
  ) {
    return this.service.getContentMix(
      this.parseFilters({
        startDate,
        endDate,
        brands,
        feeds,
        writers,
        editors,
        contentTypes,
        statuses,
        allotters,
      }),
      granularity || 'week',
    );
  }

  @Get('heatmap')
  getHeatmap(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('type') type: string,
    @Query('brands') brands: string,
    @Query('feeds') feeds: string,
    @Query('writers') writers: string,
    @Query('editors') editors: string,
    @Query('contentTypes') contentTypes: string,
    @Query('statuses') statuses: string,
    @Query('allotters') allotters: string,
  ) {
    return this.service.getHeatmap(
      this.parseFilters({
        startDate,
        endDate,
        brands,
        feeds,
        writers,
        editors,
        contentTypes,
        statuses,
        allotters,
      }),
      type || 'calendar',
    );
  }

  @Get('writer-daily')
  getWriterDailyBreakdown(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('brands') brands: string,
    @Query('feeds') feeds: string,
    @Query('writers') writers: string,
    @Query('editors') editors: string,
    @Query('contentTypes') contentTypes: string,
    @Query('statuses') statuses: string,
    @Query('allotters') allotters: string,
  ) {
    return this.service.getWriterDailyBreakdown(
      this.parseFilters({
        startDate,
        endDate,
        brands,
        feeds,
        writers,
        editors,
        contentTypes,
        statuses,
        allotters,
      }),
    );
  }

  @Get('editor-daily')
  getEditorDailyBreakdown(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('brands') brands: string,
    @Query('feeds') feeds: string,
    @Query('writers') writers: string,
    @Query('editors') editors: string,
    @Query('contentTypes') contentTypes: string,
    @Query('statuses') statuses: string,
    @Query('allotters') allotters: string,
  ) {
    return this.service.getEditorDailyBreakdown(
      this.parseFilters({
        startDate,
        endDate,
        brands,
        feeds,
        writers,
        editors,
        contentTypes,
        statuses,
        allotters,
      }),
    );
  }

  @Get('leakage')
  getLeakage(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('brands') brands: string,
    @Query('feeds') feeds: string,
    @Query('writers') writers: string,
    @Query('editors') editors: string,
    @Query('contentTypes') contentTypes: string,
    @Query('statuses') statuses: string,
    @Query('allotters') allotters: string,
  ) {
    return this.service.getLeakage(
      this.parseFilters({
        startDate,
        endDate,
        brands,
        feeds,
        writers,
        editors,
        contentTypes,
        statuses,
        allotters,
      }),
    );
  }
}
