import { Controller, Get, Query } from '@nestjs/common';
import { CombinedProductionService } from './combined-production.service';
import { Section } from '../../common/decorators/section.decorator';

/** Yahoo and Critical Flow production in one place. */
@Controller('v1/production')
@Section('cf')
export class CombinedProductionController {
  constructor(private readonly combined: CombinedProductionService) {}

  @Get('combined')
  get(@Query() query: Record<string, any>) {
    const date = (v: any) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
    return this.combined.get({
      startDate: date(query.startDate),
      endDate: date(query.endDate),
      divisions: query.divisions ? String(query.divisions).split(',').filter(Boolean) : undefined,
    });
  }
}
