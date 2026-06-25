import { Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SocialProfile } from '../entities/SocialProfile.entity';
import { AnalyticsSnapshot } from '../entities/AnalyticsSnapshot.entity';
import { SocialPost } from '../entities/SocialPost.entity';
import { DemographicSnapshot } from '../entities/DemographicSnapshot.entity';
import { DailyRevenue } from '../../revenue/entities/daily-revenue.entity';
import { RevenueMapping } from '../../revenue/entities/revenue-mapping.entity';
import {
  fetchProfileBasics,
  fetchDailySnapshot,
  fetchPostsPaginated,
  fetchPostDeepInsights,
  fetchDemographics,
  fetchDailyRevenue,
  fetchSegregatedRevenue,
} from '../services/meta.service';

@Processor('social-sync-queue')
export class SyncProcessor {
  constructor(
    @InjectRepository(SocialProfile)
    private profileRepo: Repository<SocialProfile>,
    @InjectRepository(AnalyticsSnapshot)
    private snapshotRepo: Repository<AnalyticsSnapshot>,
    @InjectRepository(SocialPost)
    private postRepo: Repository<SocialPost>,
    @InjectRepository(DemographicSnapshot)
    private demographicRepo: Repository<DemographicSnapshot>,
    @InjectRepository(DailyRevenue)
    private dailyRevenueRepo: Repository<DailyRevenue>,
    @InjectRepository(RevenueMapping)
    private revenueMappingRepo: Repository<RevenueMapping>,
  ) {}

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Re-sync data for a specific date range.
   * Same upsert-override logic as the daily cron — no data is deleted,
   * fresh values from Meta simply overwrite existing rows.
   */
  @Process('date-range-resync')
  async handleDateRangeResync(job: Job) {
    const { profileId, startDate, endDate } = job.data;

    try {
      const profile = await this.profileRepo.findOne({
        where: { profileId, isActive: true },
      });

      if (!profile) return;

      console.log(
        `\n[Worker] Starting date-range resync for ${profile.profileId} (${startDate} to ${endDate})`,
      );

      await this.profileRepo.update(
        { profileId },
        { syncState: 'SYNCING', lastSyncError: '' },
      );

      const basics = await fetchProfileBasics(
        profile.profileId,
        profile.accessToken,
        profile.platform as any,
      );

      const start = new Date(`${startDate}T00:00:00.000+05:30`);
      const end = new Date(`${endDate}T23:59:59.999+05:30`);

      // --- Chunk into 29-day windows (same as historical sync) ---
      const chunks: any[] = [];
      let currentStart = new Date(start);

      while (currentStart < end) {
        let currentEnd = new Date(currentStart);
        currentEnd.setDate(currentEnd.getDate() + 29);
        if (currentEnd > end) currentEnd = new Date(end);

        chunks.push({
          start: new Date(currentStart),
          end: new Date(currentEnd),
        });

        currentStart = new Date(currentEnd);
        currentStart.setDate(currentStart.getDate() + 1);
      }

      // --- Snapshots ---
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        console.log(
          `[Worker][Resync] Processing chunk ${i + 1}/${chunks.length} (${chunk.start.toISOString().split('T')[0]} to ${chunk.end.toISOString().split('T')[0]})...`,
        );

        const sinceUnix = Math.floor(chunk.start.getTime() / 1000);
        const untilUnix = Math.floor(chunk.end.getTime() / 1000);

        const dailyRaw = await fetchDailySnapshot(
          profile.profileId,
          profile.accessToken,
          profile.platform as any,
          sinceUnix,
          untilUnix,
        );

        const dailyDataMap: Record<string, any> = {};

        if (Array.isArray(dailyRaw)) {
          dailyRaw.forEach((metric: any) => {
            if (metric.values) {
              metric.values.forEach((val: any) => {
                const actualDate = new Date(val.end_time);
                actualDate.setDate(actualDate.getDate() - 1);
                const dateStr = actualDate.toISOString().split('T')[0];
                if (!dailyDataMap[dateStr]) dailyDataMap[dateStr] = {};
                dailyDataMap[dateStr][metric.name] = val.value;
              });
            } else if (metric.total_value) {
              const dateStr = chunk.start.toISOString().split('T')[0];
              if (!dailyDataMap[dateStr]) dailyDataMap[dateStr] = {};
              dailyDataMap[dateStr][metric.name] = metric.total_value.value;
            }
          });
        }

        const snapshotPayloads: any[] = [];
        const fillDate = new Date(chunk.start);

        while (fillDate <= chunk.end) {
          const dateStr = fillDate.toISOString().split('T')[0];
          const metrics = dailyDataMap[dateStr] || {};

          let igGained = 0;
          let igUnfollows = 0;
          if (
            profile.platform === 'instagram' &&
            metrics['follower_count'] !== undefined
          ) {
            const net = Number(metrics['follower_count']);
            if (net > 0) igGained = net;
            if (net < 0) igUnfollows = Math.abs(net);
          }

          const isFb = profile.platform === 'facebook';

          const followersGained = isFb
            ? metrics['page_daily_follows_unique'] || 0
            : igGained;
          const unfollows = isFb
            ? metrics['page_daily_unfollows_unique'] || 0
            : igUnfollows;
          const totalReach = isFb
            ? metrics['page_total_media_view_unique'] || 0
            : metrics['reach'] || 0;
          const totalImpressions = isFb
            ? metrics['page_media_view'] || 0
            : metrics['views'] || metrics['reach'] || 0;
          const videoViews = isFb ? metrics['page_video_views'] || 0 : 0;
          const totalEngagement = isFb
            ? metrics['page_post_engagements'] || 0
            : metrics['total_interactions'] || 0;
          const profileClicks = isFb
            ? metrics['page_total_actions'] || 0
            : metrics['website_clicks'] || 0;
          const pageViews = isFb
            ? metrics['page_views_total'] || 0
            : metrics['profile_views'] || 0;
          const netMessages = isFb
            ? (metrics['page_messages_new_conversations_unique'] || 0) +
              (metrics['page_messages_total_messaging_connections'] || 0)
            : 0;

          // Skip days where Meta returned no real data. Writing an all-zero
          // payload would overwrite previously-synced good values via upsert.
          // Only persist when at least one core metric carries real data, so a
          // genuine fresh update still overwrites the DB for higher accuracy.
          const hasData =
            followersGained > 0 ||
            unfollows > 0 ||
            totalReach > 0 ||
            totalImpressions > 0 ||
            videoViews > 0 ||
            totalEngagement > 0 ||
            profileClicks > 0 ||
            pageViews > 0 ||
            netMessages > 0;

          if (!hasData) {
            fillDate.setDate(fillDate.getDate() + 1);
            continue;
          }

          snapshotPayloads.push({
            profileId: profile.profileId,
            date: dateStr,
            platform: profile.platform,
            totalFollowers: basics?.followers_count || 0,
            followersGained,
            unfollows,
            totalReach,
            totalImpressions,
            videoViews,
            totalEngagement,
            profileClicks,
            pageViews,
            netMessages,
          });

          fillDate.setDate(fillDate.getDate() + 1);
        }

        if (snapshotPayloads.length > 0) {
          await this.snapshotRepo.upsert(snapshotPayloads, [
            'profileId',
            'date',
          ]);
        }
        if (i < chunks.length - 1) await this.sleep(2000);
      }

      // --- Posts ---
      console.log(`[Worker][Resync] Fetching posts for ${profileId}...`);

      const recentPosts = await fetchPostsPaginated(
        profile.profileId,
        profile.accessToken,
        profile.platform as any,
        start,
        end,
      );

      const postPayloads: any[] = [];
      for (const post of recentPosts) {
        const rawType = (
          post.status_type ||
          post.media_type ||
          post.media_product_type ||
          'UNKNOWN'
        ).toLowerCase();
        let normalizedType = 'text';

        if (rawType.includes('video') || rawType.includes('reel')) {
          normalizedType = 'video';
        } else if (
          rawType.includes('photo') ||
          rawType.includes('image') ||
          rawType.includes('carousel') ||
          rawType.includes('album')
        ) {
          normalizedType = 'photo';
        }

        let views = 0,
          reach = 0,
          clicks = 0,
          shares = 0;

        try {
          const deep = await fetchPostDeepInsights(
            post.id,
            profile.accessToken,
            profile.platform as any,
            rawType,
          );
          // Some new "media view" metrics return TWO entries for one name — a
          // `lifetime` total and a `day` series. We want the lifetime total
          // (matches the old post_impressions_unique semantics), so prefer it
          // explicitly rather than relying on Meta's response ordering.
          const getInsight = (arr: any[], name: string) => {
            const entries = (arr || []).filter((i: any) => i.name === name);
            const chosen =
              entries.find((e: any) => e.period === 'lifetime') || entries[0];
            return chosen?.values?.[0]?.value || 0;
          };

          if (profile.platform === 'facebook') {
            clicks = getInsight(deep, 'post_clicks');
            reach = getInsight(deep, 'post_total_media_view_unique');
            views = getInsight(deep, 'post_media_view');
            shares = post.shares?.count || post.shares_count || 0;
          } else {
            reach = getInsight(deep, 'reach');
            views = getInsight(deep, 'views');
            shares = getInsight(deep, 'shares') || 0;
            clicks = getInsight(deep, 'saved') || 0;
          }
          await this.sleep(200);
        } catch (e) {}

        postPayloads.push({
          profileId: profile.profileId,
          postId: post.id,
          platform: profile.platform,
          postType: normalizedType,
          message: post.message || post.caption || '',
          mediaUrl:
            post.media_url || post.attachments?.data?.[0]?.media?.source || '',
          thumbnailUrl:
            post.full_picture ||
            post.picture ||
            post.thumbnail_url ||
            post.media_url ||
            post.attachments?.data?.[0]?.media?.image?.src ||
            '',
          permalink: post.permalink_url || post.permalink || '',
          isPublished:
            post.is_published !== undefined ? post.is_published : true,
          isBoosted: false,
          authorName: post.from?.name || post.owner?.username || 'Unknown',
          postedAt: new Date(post.created_time || post.timestamp),
          likes: post.likes?.summary?.total_count || post.like_count || 0,
          comments:
            post.comments?.summary?.total_count || post.comments_count || 0,
          shares,
          reach,
          views,
          clicks,
        });
      }

      if (postPayloads.length > 0) {
        await this.postRepo.upsert(postPayloads, ['postId']);
      }

      // --- Revenue (Facebook only) ---
      if (profile.platform === 'facebook') {
        console.log(
          `[Worker][Resync] Fetching revenue data for ${profileId}...`,
        );
        try {
          const sinceUnix = Math.floor(start.getTime() / 1000);
          const untilUnix = Math.floor(end.getTime() / 1000);

          const segregated = await fetchSegregatedRevenue(
            profile.profileId,
            profile.accessToken,
            sinceUnix,
            untilUnix,
          );

          if (segregated.length > 0) {
            const payloads = segregated.map((day) => ({
              pageId: profile.profileId,
              date: day.date,
              bonusRevenue: day.bonus,
              photoRevenue: day.photo,
              reelRevenue: day.reel,
              storyRevenue: day.story,
              textRevenue: day.text,
              totalRevenue: day.total,
            }));

            await this.dailyRevenueRepo.upsert(payloads, ['pageId', 'date']);

            for (const day of segregated) {
              await this.snapshotRepo.update(
                { profileId: profile.profileId, date: day.date },
                { revenue: day.total },
              );
            }

            console.log(
              `[Worker][Resync] Revenue saved for ${profileId} (${segregated.length} days).`,
            );
          }
        } catch (revErr: any) {
          console.warn(
            `[Worker][Resync] Revenue fetch skipped for ${profileId}:`,
            revErr.message,
          );
        }
      }

      await this.profileRepo.update(
        { profileId },
        { syncState: 'COMPLETED', lastSyncError: undefined },
      );
      console.log(
        `[Worker][Resync] Successfully finished date-range resync for ${profileId} (${startDate} to ${endDate}).\n`,
      );
    } catch (error: any) {
      console.error(`[Worker][Resync] Failed for ${profileId}:`, error.message);
      await this.profileRepo.update(
        { profileId },
        {
          syncState: 'FAILED',
          lastSyncError: error.message || 'Date-range resync failed',
        },
      );
    }
  }

  /**
   * Monthly revenue sync — runs on the 28th of each month (triggered by CronService).
   * Fetches segregated revenue for the whole current month (1st → today) for a
   * single Facebook page. Revenue data from Meta often has a 3–7 day processing
   * delay, so re-fetching the full month on the 28th ensures even the earliest
   * days of the month are fully settled and accurate.
   * Does NOT touch snapshot or post data — revenue only.
   */
  @Process('monthly-revenue-sync')
  async handleMonthlyRevenueSync(job: Job) {
    const { profileId } = job.data;

    try {
      const profile = await this.profileRepo.findOne({
        where: { profileId, isActive: true, platform: 'facebook' as any },
      });

      if (!profile) {
        console.log(
          `[Worker][MonthlyRev] Profile ${profileId} not found or inactive — skipping.`,
        );
        return;
      }

      // Always sync 1st of current month → today
      const now = new Date();
      const monthStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      );
      const monthEnd = now;

      const sinceUnix = Math.floor(monthStart.getTime() / 1000);
      const untilUnix = Math.floor(monthEnd.getTime() / 1000);

      console.log(
        `[Worker][MonthlyRev] Syncing revenue for ${profile.profileId} (${monthStart.toISOString().split('T')[0]} → ${monthEnd.toISOString().split('T')[0]})...`,
      );

      const segregated = await fetchSegregatedRevenue(
        profile.profileId,
        profile.accessToken,
        sinceUnix,
        untilUnix,
      );

      if (segregated.length === 0) {
        console.log(
          `[Worker][MonthlyRev] No revenue data returned for ${profileId} — skipping upsert.`,
        );
        return;
      }

      const payloads = segregated.map((day) => ({
        pageId: profile.profileId,
        date: day.date,
        bonusRevenue: day.bonus,
        photoRevenue: day.photo,
        reelRevenue: day.reel,
        storyRevenue: day.story,
        textRevenue: day.text,
        totalRevenue: day.total,
      }));

      await this.dailyRevenueRepo.upsert(payloads, ['pageId', 'date']);

      // Keep analytics_snapshots.revenue in sync for the report graph
      for (const day of segregated) {
        await this.snapshotRepo.update(
          { profileId: profile.profileId, date: day.date },
          { revenue: day.total },
        );
      }

      console.log(
        `[Worker][MonthlyRev] Revenue saved for ${profileId} (${segregated.length} days).`,
      );
    } catch (error: any) {
      console.error(
        `[Worker][MonthlyRev] Failed for ${profileId}:`,
        error.message,
      );
    }
  }

  @Process('initial-historical-sync')
  async handleHistoricalSync(job: Job) {
    const { profileId, daysToFetch = 85 } = job.data;

    try {
      const profile = await this.profileRepo.findOne({
        where: { profileId, isActive: true },
      });

      if (!profile) return;

      console.log(
        `\n[Worker] Starting historical ${daysToFetch}-day sync for profile ${profile.profileId}`,
      );

      await this.profileRepo.update(
        { profileId },
        { syncState: 'SYNCING', lastSyncError: '' },
      );

      const basics = await fetchProfileBasics(
        profile.profileId,
        profile.accessToken,
        profile.platform as any,
      );

      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - daysToFetch);

      const chunks: any[] = [];
      let currentStart = new Date(start);

      while (currentStart < end) {
        let currentEnd = new Date(currentStart);
        currentEnd.setDate(currentEnd.getDate() + 29);
        if (currentEnd > end) currentEnd = new Date(end);

        chunks.push({
          start: new Date(currentStart),
          end: new Date(currentEnd),
        });

        currentStart = new Date(currentEnd);
        currentStart.setDate(currentStart.getDate() + 1);
      }

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        console.log(
          `[Worker] Processing chunk ${i + 1}/${chunks.length} (${chunk.start.toISOString().split('T')[0]} to ${chunk.end.toISOString().split('T')[0]})...`,
        );

        const sinceUnix = Math.floor(chunk.start.getTime() / 1000);
        const untilUnix = Math.floor(chunk.end.getTime() / 1000);

        const dailyRaw = await fetchDailySnapshot(
          profile.profileId,
          profile.accessToken,
          profile.platform as any,
          sinceUnix,
          untilUnix,
        );

        const dailyDataMap: Record<string, any> = {};

        if (Array.isArray(dailyRaw)) {
          dailyRaw.forEach((metric: any) => {
            if (metric.values) {
              metric.values.forEach((val: any) => {
                const actualDate = new Date(val.end_time);
                actualDate.setDate(actualDate.getDate() - 1);
                const dateStr = actualDate.toISOString().split('T')[0];
                if (!dailyDataMap[dateStr]) dailyDataMap[dateStr] = {};
                dailyDataMap[dateStr][metric.name] = val.value;
              });
            } else if (metric.total_value) {
              const dateStr = chunk.start.toISOString().split('T')[0];
              if (!dailyDataMap[dateStr]) dailyDataMap[dateStr] = {};
              dailyDataMap[dateStr][metric.name] = metric.total_value.value;
            }
          });
        }

        const snapshotPayloads: any[] = [];
        const fillDate = new Date(chunk.start);

        while (fillDate <= chunk.end) {
          const dateStr = fillDate.toISOString().split('T')[0];
          const metrics = dailyDataMap[dateStr] || {};

          let igGained = 0;
          let igUnfollows = 0;
          if (
            profile.platform === 'instagram' &&
            metrics['follower_count'] !== undefined
          ) {
            const net = Number(metrics['follower_count']);
            if (net > 0) igGained = net;
            if (net < 0) igUnfollows = Math.abs(net);
          }

          const isFb = profile.platform === 'facebook';

          const followersGained = isFb
            ? metrics['page_daily_follows_unique'] || 0
            : igGained;
          const unfollows = isFb
            ? metrics['page_daily_unfollows_unique'] || 0
            : igUnfollows;
          const totalReach = isFb
            ? metrics['page_total_media_view_unique'] || 0
            : metrics['reach'] || 0;
          const totalImpressions = isFb
            ? metrics['page_media_view'] || 0
            : metrics['views'] || metrics['reach'] || 0;
          const videoViews = isFb ? metrics['page_video_views'] || 0 : 0;
          const totalEngagement = isFb
            ? metrics['page_post_engagements'] || 0
            : metrics['total_interactions'] || 0;
          const profileClicks = isFb
            ? metrics['page_total_actions'] || 0
            : metrics['website_clicks'] || 0;
          const pageViews = isFb
            ? metrics['page_views_total'] || 0
            : metrics['profile_views'] || 0;
          const netMessages = isFb
            ? (metrics['page_messages_new_conversations_unique'] || 0) +
              (metrics['page_messages_total_messaging_connections'] || 0)
            : 0;

          // Skip days where Meta returned no real data. Writing an all-zero
          // payload would overwrite previously-synced good values via upsert.
          // Only persist when at least one core metric carries real data, so a
          // genuine fresh update still overwrites the DB for higher accuracy.
          const hasData =
            followersGained > 0 ||
            unfollows > 0 ||
            totalReach > 0 ||
            totalImpressions > 0 ||
            videoViews > 0 ||
            totalEngagement > 0 ||
            profileClicks > 0 ||
            pageViews > 0 ||
            netMessages > 0;

          if (!hasData) {
            fillDate.setDate(fillDate.getDate() + 1);
            continue;
          }

          snapshotPayloads.push({
            profileId: profile.profileId,
            date: dateStr,
            platform: profile.platform,
            totalFollowers: basics?.followers_count || 0,
            followersGained,
            unfollows,
            totalReach,
            totalImpressions,
            videoViews,
            totalEngagement,
            profileClicks,
            pageViews,
            netMessages,
          });

          fillDate.setDate(fillDate.getDate() + 1);
        }

        if (snapshotPayloads.length > 0) {
          await this.snapshotRepo.upsert(snapshotPayloads, [
            'profileId',
            'date',
          ]);
        }
        if (i < chunks.length - 1) await this.sleep(2000);
      }

      console.log(`[Worker] Found ${chunks.length} chunks. Fetching Posts...`);

      const recentPosts = await fetchPostsPaginated(
        profile.profileId,
        profile.accessToken,
        profile.platform as any,
        start,
        end,
      );

      const postPayloads: any[] = [];
      for (const post of recentPosts) {
        const rawType = (
          post.status_type ||
          post.media_type ||
          post.media_product_type ||
          'UNKNOWN'
        ).toLowerCase();
        let normalizedType = 'text';

        if (rawType.includes('video') || rawType.includes('reel')) {
          normalizedType = 'video';
        } else if (
          rawType.includes('photo') ||
          rawType.includes('image') ||
          rawType.includes('carousel') ||
          rawType.includes('album')
        ) {
          normalizedType = 'photo';
        }

        let views = 0,
          reach = 0,
          clicks = 0,
          shares = 0;

        try {
          const deep = await fetchPostDeepInsights(
            post.id,
            profile.accessToken,
            profile.platform as any,
            rawType,
          );
          // Some new "media view" metrics return TWO entries for one name — a
          // `lifetime` total and a `day` series. We want the lifetime total
          // (matches the old post_impressions_unique semantics), so prefer it
          // explicitly rather than relying on Meta's response ordering.
          const getInsight = (arr: any[], name: string) => {
            const entries = (arr || []).filter((i: any) => i.name === name);
            const chosen =
              entries.find((e: any) => e.period === 'lifetime') || entries[0];
            return chosen?.values?.[0]?.value || 0;
          };

          if (profile.platform === 'facebook') {
            clicks = getInsight(deep, 'post_clicks');
            reach = getInsight(deep, 'post_total_media_view_unique');
            views = getInsight(deep, 'post_media_view');
            shares = post.shares?.count || post.shares_count || 0;
          } else {
            reach = getInsight(deep, 'reach');
            views = getInsight(deep, 'views');
            shares = getInsight(deep, 'shares') || 0;
            clicks = getInsight(deep, 'saved') || 0;
          }
          await this.sleep(200);
        } catch (e) {}

        postPayloads.push({
          profileId: profile.profileId,
          postId: post.id,
          platform: profile.platform,
          postType: normalizedType,
          message: post.message || post.caption || '',
          mediaUrl:
            post.media_url || post.attachments?.data?.[0]?.media?.source || '',
          thumbnailUrl:
            post.full_picture ||
            post.picture ||
            post.thumbnail_url ||
            post.media_url ||
            post.attachments?.data?.[0]?.media?.image?.src ||
            '',
          permalink: post.permalink_url || post.permalink || '',
          isPublished:
            post.is_published !== undefined ? post.is_published : true,
          isBoosted: false,
          authorName: post.from?.name || post.owner?.username || 'Unknown',
          postedAt: new Date(post.created_time || post.timestamp),
          likes: post.likes?.summary?.total_count || post.like_count || 0,
          comments:
            post.comments?.summary?.total_count || post.comments_count || 0,
          shares,
          reach,
          views,
          clicks,
        });
      }

      if (postPayloads.length > 0) {
        await this.postRepo.upsert(postPayloads, ['postId']);
      }

      // --- DEMOGRAPHICS: Fetch lifetime audience data ---
      console.log(`[Worker] Fetching demographics for ${profileId}...`);
      try {
        const demographics = await fetchDemographics(
          profile.profileId,
          profile.accessToken,
          profile.platform as any,
        );

        const today = new Date().toISOString().split('T')[0];
        await this.demographicRepo.upsert(
          {
            profileId: profile.profileId,
            date: today,
            platform: profile.platform,
            genderAge: demographics.genderAge,
            topCities: demographics.topCities,
            topCountries: demographics.topCountries,
          },
          ['profileId', 'date'],
        );
        console.log(`[Worker] Demographics saved for ${profileId}.`);
      } catch (demoErr: any) {
        console.warn(
          `[Worker] Demographics fetch skipped for ${profileId}:`,
          demoErr.message,
        );
      }

      // --- REVENUE: Fetch segregated daily revenue for Facebook pages only ---
      if (profile.platform === 'facebook') {
        console.log(
          `[Worker] Fetching segregated revenue data for ${profileId}...`,
        );
        try {
          const sinceUnix = Math.floor(start.getTime() / 1000);
          const untilUnix = Math.floor(end.getTime() / 1000);

          // Ensure this page has a RevenueMapping entry
          const existingMapping = await this.revenueMappingRepo.findOne({
            where: { pageId: profile.profileId },
          });
          if (!existingMapping) {
            await this.revenueMappingRepo.save({
              pageId: profile.profileId,
              pageName: basics?.name || profile.name || profile.profileId,
              team: 'Unassigned',
            });
            console.log(
              `[Worker] Auto-created revenue mapping for page "${basics?.name || profile.profileId}"`,
            );
          } else if (basics?.name && existingMapping.pageName !== basics.name) {
            // Keep page name in sync
            await this.revenueMappingRepo.update(existingMapping.id, {
              pageName: basics.name,
            });
          }

          // Fetch segregated revenue (bonus, photo, reel, story, text)
          const segregated = await fetchSegregatedRevenue(
            profile.profileId,
            profile.accessToken,
            sinceUnix,
            untilUnix,
          );

          if (segregated.length > 0) {
            // Upsert into daily_revenue table
            const payloads = segregated.map((day) => ({
              pageId: profile.profileId,
              date: day.date,
              bonusRevenue: day.bonus,
              photoRevenue: day.photo,
              reelRevenue: day.reel,
              storyRevenue: day.story,
              textRevenue: day.text,
              totalRevenue: day.total,
            }));

            await this.dailyRevenueRepo.upsert(payloads, ['pageId', 'date']);

            // Keep analytics_snapshots.revenue in sync (Reports page reads this).
            // Always write — even when total is 0 — so stale/incorrect values
            // from previous syncs get corrected.
            for (const day of segregated) {
              await this.snapshotRepo.update(
                { profileId: profile.profileId, date: day.date },
                { revenue: day.total },
              );
            }

            console.log(
              `[Worker] Segregated revenue saved for ${profileId} (${segregated.length} days).`,
            );
          }
        } catch (revErr: any) {
          console.warn(
            `[Worker] Revenue fetch skipped for ${profileId}:`,
            revErr.message,
          );
        }
      }

      await this.profileRepo.update(
        { profileId },
        { syncState: 'COMPLETED', lastSyncError: undefined },
      );
      console.log(
        `[Worker] Successfully finished sync for ${job.data.profileId}.\n`,
      );
    } catch (error: any) {
      await this.profileRepo.update(
        { profileId },
        {
          syncState: 'FAILED',
          lastSyncError: error.message || 'Worker sync failed',
        },
      );
    }
  }
}
