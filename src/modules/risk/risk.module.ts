import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RiskController } from './risk.controller';
import { RiskService } from './risk.service';

import { AnalyticsSnapshot } from '../facebook/entities/AnalyticsSnapshot.entity';
import { SocialPost } from '../facebook/entities/SocialPost.entity';
import { SocialProfile } from '../facebook/entities/SocialProfile.entity';
import { ReportSportsMapping } from '../report-sports-mappings/entities/report-sports-mapping.entity';
import { PageMapping } from '../page-mappings/entities/page-mapping.entity';
import { PagePathMapping } from '../page-mappings/entities/page-path-mapping.entity';
import { TrafficDaily } from '../utm-analytics/entities/traffic-daily.entity';
import { TrafficPageDaily } from '../utm-analytics/entities/traffic-page-daily.entity';

/**
 * Read-only. This module registers no writers, no queues and no cron jobs - it
 * reads what the sync workers already maintain and reshapes it to week grain.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AnalyticsSnapshot,
      SocialPost,
      SocialProfile,
      ReportSportsMapping,
      PageMapping,
      PagePathMapping,
      TrafficDaily,
      TrafficPageDaily,
    ]),
  ],
  controllers: [RiskController],
  providers: [RiskService],
})
export class RiskModule {}
