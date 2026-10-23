import { Controller, Get, Query } from '@nestjs/common';
import { CombinedProductionService } from './combined-production.service';
import { Section } from '../../common/decorators/section.decorator';

/** Written / edited / published per source sheet — the one page AHE Users get. */
@Controller('v1/production')
@Section('roundup')
export class SheetRoundupController {
  constructor(private readonly combined: CombinedProductionService) {}

  @Get('roundup')
  get(@Query() query: Record<string, any>) {
    const date = (v: any) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
    return this.combined.roundup({ startDate: date(query.startDate), endDate: date(query.endDate) });
  }
}
