import { Controller, Get, Query } from '@nestjs/common';
import { Section } from '../../common/decorators/section.decorator';
import { OverviewService } from './overview.service';

/** The Dashboard: production joined to the social traffic it drew. */
@Controller('v1/overview')
@Section('sm')
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get()
  get(@Query() query: Record<string, any>) {
    const date = (v: any) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
    const startDate = date(query.startDate);
    const endDate = date(query.endDate);
    return this.overview.get(
      startDate && endDate && startDate > endDate
        ? { startDate: endDate, endDate: startDate }
        : { startDate, endDate },
    );
  }
}
