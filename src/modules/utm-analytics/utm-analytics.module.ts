import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnalyticsService } from './utm-analytics.service';
import { AnalyticsController } from './utm-analytics.controller';
import { TrafficDaily } from './entities/traffic-daily.entity';
import { TrafficCountryDaily } from './entities/traffic-country-daily.entity';
import { TrafficPageDaily } from './entities/traffic-page-daily.entity';
import { PagePathMapping } from '../page-mappings/entities/page-path-mapping.entity';
import { BigQueryModule } from '../../common/bigquery/bigquery.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TrafficDaily,
      TrafficCountryDaily,
      TrafficPageDaily,
      PagePathMapping,
    ]),
    BigQueryModule,
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class UtmAnalyticsModule {}
