import { Controller, Get, Query } from '@nestjs/common';
import { WeeklyReportService } from './weekly-report.service';
import { Section } from '../../common/decorators/section.decorator';

@Controller('v1/cf-weekly-report')
@Section('cf')
export class WeeklyReportController {
  constructor(private readonly service: WeeklyReportService) {}

  /**
   * ?end=YYYY-MM-DD picks the last week shown (the week in progress allowed);
   * defaults to the latest complete one. ?weeks=N shows N weeks (1–8, default 4).
   */
  @Get()
  getReport(@Query('end') end?: string, @Query('weeks') weeks?: string) {
    return this.service.getReport(end, weeks ? Number(weeks) : undefined);
  }
}
