import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { McpSocialController } from './mcp-social.controller';
import { McpSocialService } from './mcp-social.service';
import { TrafficDaily } from '../utm-analytics/entities/traffic-daily.entity';
import { TrafficPageDaily } from '../utm-analytics/entities/traffic-page-daily.entity';
import { PagePathMapping } from '../page-mappings/entities/page-path-mapping.entity';
import { SocialPost } from '../facebook/entities/SocialPost.entity';
import { SocialProfile } from '../facebook/entities/SocialProfile.entity';
import { AnalyticsSnapshot } from '../facebook/entities/AnalyticsSnapshot.entity';

/**
 * Read-only social endpoints for the ES MCP server.
 *
 * Registers the entities for feature injection only — the tables are owned and
 * written by UtmAnalyticsModule and FacebookModule. Nothing in here writes,
 * syncs, or queues.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TrafficDaily,
      TrafficPageDaily,
      PagePathMapping,
      SocialPost,
      SocialProfile,
      AnalyticsSnapshot,
    ]),
  ],
  controllers: [McpSocialController],
  providers: [McpSocialService],
})
export class McpSocialModule {}
