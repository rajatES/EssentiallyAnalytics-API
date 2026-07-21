import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';

import { SocialProfile } from './entities/SocialProfile.entity';
import { AnalyticsSnapshot } from './entities/AnalyticsSnapshot.entity';
import { SocialPost } from './entities/SocialPost.entity';
import { DemographicSnapshot } from './entities/DemographicSnapshot.entity';
import { DailyRevenue } from '../revenue/entities/daily-revenue.entity';
import { PostLinkComment } from '../comment-links/entities/post-link-comment.entity';

import { AnalyticsController } from './controllers/analytics.controller';

import { CronService } from './services/cron.service';
import { SyncProcessor } from './workers/sync.processor';
import { AuthController } from './controllers/auth.Controller';
import { RevenueModule } from '../revenue/revenue.module';
import { CommentLinksModule } from '../comment-links/comment-links.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SocialProfile,
      AnalyticsSnapshot,
      SocialPost,
      DemographicSnapshot,
      DailyRevenue,
      PostLinkComment,
    ]),
    BullModule.registerQueue({
      name: 'social-sync-queue',
    }),
    RevenueModule,
    CommentLinksModule,
  ],
  controllers: [AnalyticsController, AuthController],
  providers: [CronService, SyncProcessor],
})
export class FacebookModule {}
