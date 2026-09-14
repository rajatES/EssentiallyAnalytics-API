import { Controller, Get, Query } from '@nestjs/common';
import { McpSocialService, type PostSort } from './mcp-social.service';

const SORTS: PostSort[] = ['engagement', 'reach', 'views', 'clicks', 'recent'];

/**
 * The read-only surface the ES MCP server calls.
 *
 * Deliberately separate from the UI's controllers rather than an extra method
 * on each of them. The UI endpoints are shaped by what a React panel needs —
 * POST bodies carrying profileId arrays, per-day series the chart will re-bin,
 * sync side-effects triggered on read. An MCP tool wants one GET, one answer,
 * no writes, and a payload small enough to put in a model's context. Keeping
 * the two apart means neither has to compromise, and a change to the dashboard
 * cannot silently change what the MCP reports.
 *
 * Authentication is the existing global ApiKeyGuard: the MCP holds its own
 * `users.apiKey` and sends it as x-api-key, so its calls are attributable and
 * revocable on their own without disturbing anyone's browser session. Nothing
 * here is @Public.
 */
@Controller('v1/social')
export class McpSocialController {
  constructor(private readonly service: McpSocialService) {}

  /**
   * Latest available date per feed, the platform vocabulary, and the connected
   * profiles. Tools call this first so they can say "as of the 12th" rather
   * than reporting an unsynced day as zero.
   */
  @Get('meta')
  async getMeta() {
    return this.service.getAvailability();
  }

  /** Social sessions by platform, with a daily series unless daily=false. */
  @Get('traffic/summary')
  async getTrafficSummary(
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('platform') platform?: string,
    @Query('daily') daily?: string,
  ) {
    return this.service.getTrafficSummary({
      range: await this.service.resolveRange(start, end),
      platform: this.service.resolvePlatform(platform),
      daily: daily !== 'false',
    });
  }

  /** Top landing pages for social traffic, resolved through the path mappings. */
  @Get('traffic/pages')
  async getTopPages(
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('platform') platform?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.getTopPages({
      range: await this.service.resolveRange(start, end),
      platform: this.service.resolvePlatform(platform),
      limit: toInt(limit, 50),
    });
  }

  /** Tagged social traffic by campaign/medium/source. */
  @Get('traffic/campaigns')
  async getCampaigns(
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('platform') platform?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.getCampaigns({
      range: await this.service.resolveRange(start, end),
      platform: this.service.resolvePlatform(platform),
      limit: toInt(limit, 50),
    });
  }

  /** Per-post on-platform performance for the owned Meta accounts. */
  @Get('posts')
  async getPosts(
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('platform') platform?: string,
    @Query('profileIds') profileIds?: string,
    @Query('limit') limit?: string,
    @Query('sortBy') sortBy?: string,
  ) {
    const sort = SORTS.includes(sortBy as PostSort)
      ? (sortBy as PostSort)
      : 'engagement';
    return this.service.getPosts({
      range: await this.service.resolveRange(start, end),
      platform,
      profileIds,
      limit: toInt(limit, 25),
      sortBy: sort,
    });
  }

  /** Page-level account performance (followers, reach, engagement). */
  @Get('profiles/performance')
  async getProfilePerformance(
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('platform') platform?: string,
    @Query('profileIds') profileIds?: string,
  ) {
    return this.service.getProfilePerformance({
      range: await this.service.resolveRange(start, end),
      platform,
      profileIds,
    });
  }
}

/** Query params arrive as strings; fall back rather than sending NaN to a LIMIT. */
function toInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
