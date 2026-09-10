import { IsInt, IsOptional, IsIn, Matches, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Every risk read takes the same window: a report week plus how many weeks of
 * history to return with it.
 *
 * The consumer (the weekly risk routine) holds no state — it recomputes last
 * week, the trailing-4 comparison and the persistence counters from whatever
 * one call returns. So the window is the contract, not a convenience.
 */
export class RiskWindowDto {
  /**
   * Sunday that ends the report week. Validated as a Sunday in the service,
   * because a Monday-anchored window silently shifts every comparison by a day
   * and nothing downstream would notice.
   */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'week_ending must be an ISO date (YYYY-MM-DD)',
  })
  week_ending: string;

  /** Weeks of history to return, inclusive of the report week. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  weeks?: number = 16;
}

export class RiskPostsWindowDto extends RiskWindowDto {
  /** How many individual posts to return alongside the weekly aggregates. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(200)
  top?: number = 25;
}

export class RiskReferralWindowDto extends RiskWindowDto {
  /** Restrict to one platform. Omit for all known platforms. */
  @IsOptional()
  @IsIn(['fb', 'threads', 'reddit'])
  platform?: string;
}
