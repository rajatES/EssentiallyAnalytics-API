import { Controller, Get, Query } from '@nestjs/common';
import { RiskService } from './risk.service';
import {
  RiskPostsWindowDto,
  RiskReferralWindowDto,
  RiskWindowDto,
} from './dto/risk-window.dto';

/**
 * Read-only week-grain feeds for the weekly risk routine.
 *
 * Deliberately separate from the dashboard controllers. Those serve a UI and
 * are shaped for it - daily grain, filter-driven, free to change when the
 * dashboard changes. These are a contract with an external consumer that scores
 * and ranks on the numbers, so the grain and the column names are fixed and a
 * change here is a breaking change.
 *
 * Every response carries `retrieved_at` and `row_count`. The consumer records
 * both as provenance, which is what lets it answer "the number changed" with
 * "the source changed" rather than a guess.
 *
 * Authentication is the standard guard: an `auth_token` cookie, or an
 * `x-api-key` header for machine-to-machine callers that hold no cookie jar.
 */
@Controller('v1/risk')
export class RiskController {
  constructor(private readonly riskService: RiskService) {}

  /** Platform-side reach, engagement and follower movement per page per week. */
  @Get('social-engagement')
  async socialEngagement(@Query() query: RiskWindowDto) {
    return this.riskService.socialEngagement(
      query.week_ending,
      query.weeks ?? 16,
    );
  }

  /** Weekly publishing volume and interactions, plus the report week's top posts. */
  @Get('social-posts')
  async socialPosts(@Query() query: RiskPostsWindowDto) {
    return this.riskService.socialPosts(
      query.week_ending,
      query.weeks ?? 16,
      query.top ?? 25,
    );
  }

  /** UTM-tagged sessions by source, medium and campaign. */
  @Get('social-referral')
  async socialReferral(@Query() query: RiskReferralWindowDto) {
    return this.riskService.socialReferral(
      query.week_ending,
      query.weeks ?? 16,
      query.platform,
    );
  }

  /** Untagged referral resolved by landing page, with an unmapped exceptions block. */
  @Get('landing-referral')
  async landingReferral(@Query() query: RiskReferralWindowDto) {
    return this.riskService.landingReferral(
      query.week_ending,
      query.weeks ?? 16,
      query.platform,
    );
  }

  /** The mapping tables and the platform registry, for reconciliation. */
  @Get('mappings')
  async mappings() {
    return this.riskService.mappings();
  }

  /** Date ranges held per source and profile sync health. */
  @Get('coverage')
  async coverage() {
    return this.riskService.coverage();
  }
}
