import { Controller, Get, Query } from '@nestjs/common';
import { WeeklyReportService } from './weekly-report.service';

@Controller('v1/cf-weekly-report')
export class WeeklyReportController {
  constructor(private readonly service: WeeklyReportService) {}

  /** ?end=YYYY-MM-DD picks the last week shown; defaults to the latest complete one. */
  @Get()
  getReport(@Query('end') end?: string) {
    return this.service.getReport(end);
  }
}
