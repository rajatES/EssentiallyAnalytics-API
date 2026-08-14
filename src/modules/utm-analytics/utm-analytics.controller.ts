import {
  Controller,
  Get,
  Post,
  Query,
  HttpException,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AnalyticsService } from './utm-analytics.service';

@Controller('v1/analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('headlines')
  async getHeadlines(@Query('utmSource') utmSource?: string | string[]) {
    const filters = {
      utmSource: this.normalizeArray(utmSource),
    };
    return await this.analyticsService.getHeadlines(filters);
  }

  @Get('utm/metrics-aggregated')
  async getAggregatedMetrics(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('utmSource') utmSource?: string | string[],
    @Query('utmMedium') utmMedium?: string | string[],
    @Query('utmCampaign') utmCampaign?: string | string[],
  ) {
    if (!startDate || !endDate) {
      throw new HttpException(
        'Missing startDate or endDate',
        HttpStatus.BAD_REQUEST,
      );
    }

    const filters = {
      utmSource: this.normalizeArray(utmSource),
      utmMedium: this.normalizeArray(utmMedium),
      utmCampaign: this.normalizeArray(utmCampaign),
    };

    return await this.analyticsService.getAggregatedMetrics(
      startDate,
      endDate,
      filters,
    );
  }

  @Get('campaigns')
  async getCampaigns(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('utmSource') utmSource?: string | string[],
  ) {
    if (!startDate || !endDate) {
      throw new HttpException(
        'Missing startDate or endDate',
        HttpStatus.BAD_REQUEST,
      );
    }
    const filters = { utmSource: this.normalizeArray(utmSource) };
    return await this.analyticsService.getAvailableCampaigns(
      startDate,
      endDate,
      filters,
    );
  }

  @Get('country-stats')
  async getCountryStats(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('utmSource') utmSource?: string | string[],
  ) {
    if (!startDate || !endDate) {
      throw new HttpException(
        'Missing startDate or endDate',
        HttpStatus.BAD_REQUEST,
      );
    }
    const filters = { utmSource: this.normalizeArray(utmSource) };
    return await this.analyticsService.getCountryStats(
      startDate,
      endDate,
      filters,
    );
  }

  /** Top landing pages for a platform — the readable view for untagged traffic. */
  @Get('pages')
  async getTopPages(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('utmSource') utmSource?: string | string[],
    @Query('limit') limit?: string,
  ) {
    if (!startDate || !endDate) {
      throw new HttpException(
        'Missing startDate or endDate',
        HttpStatus.BAD_REQUEST,
      );
    }
    const filters = { utmSource: this.normalizeArray(utmSource) };
    const parsedLimit = Number(limit);
    return await this.analyticsService.getTopPages(
      startDate,
      endDate,
      filters,
      Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 100,
    );
  }

  /** Rebuild the landing-page aggregate in BQ and sync it. Defaults to 3 days. */
  @Post('sync/pages')
  async syncPages(@Query('days') days?: string) {
    const parsed = Number(days);
    const result = await this.analyticsService.refreshPageMetrics(
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 120) : 3,
    );
    return {
      status: 'success',
      message: `Page metrics refreshed for ${result.start}..${result.end} (${result.count} rows)`,
    };
  }

  @Post('sync/manual')
  async triggerManualSync() {
    await this.analyticsService.syncBigQueryData();
    return { status: 'success', message: 'Sync completed' };
  }

  // One-time historical backfill: rebuilds the BQ aggregates across the full
  // date range and syncs everything into Postgres. Remove once backfill is done.
  @Post('sync/backfill')
  async triggerBackfill(
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    const result = await this.analyticsService.backfillFromBigQuery(
      start || '20260203',
      end,
    );
    return {
      status: 'success',
      message: `Backfill complete for ${result.startSuffix}..${result.endSuffix}`,
    };
  }

  @Post('import/legacy')
  @UseInterceptors(FileInterceptor('file'))
  async importLegacyData(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new HttpException('No CSV file provided', HttpStatus.BAD_REQUEST);
    }

    try {
      const count = await this.analyticsService.importLegacyData(file.buffer);
      return {
        status: 'success',
        message: `Imported ${count} legacy records successfully.`,
      };
    } catch (error) {
      throw new HttpException(
        error instanceof Error ? error.message : 'Import failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private normalizeArray(param?: string | string[]): string[] | undefined {
    if (!param) return undefined;
    return Array.isArray(param) ? param : [param];
  }
}
