import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { SocialProfile } from '../entities/SocialProfile.entity';
import { AnalyticsSnapshot } from '../entities/AnalyticsSnapshot.entity';
import { SocialPost } from '../entities/SocialPost.entity';
import { CommentLinksService } from '../../comment-links/comment-links.service';

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(
    @InjectRepository(SocialProfile)
    private profileRepo: Repository<SocialProfile>,
    @InjectRepository(AnalyticsSnapshot)
    private snapshotRepo: Repository<AnalyticsSnapshot>,
    @InjectRepository(SocialPost)
    private postRepo: Repository<SocialPost>,
    @InjectQueue('social-sync-queue') private syncQueue: Queue,
    private readonly commentLinksService: CommentLinksService,
  ) {}

  @Cron('0 16 * * *', { timeZone: 'Asia/Kolkata' })
  async handleDailySync4PM() {
    await this.handleDailySync();
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleDailySync(options?: { skipCommentLinks?: boolean }) {
    this.logger.log(
      'Starting automated daily background sync for active profiles...',
    );

    // Check if any sync jobs are currently active or waiting in the queue.
    // If so, skip the entire daily sync to avoid interrupting ongoing imports.
    const activeJobCount = await this.syncQueue.getActiveCount();
    const waitingJobCount = await this.syncQueue.getWaitingCount();

    if (activeJobCount > 0 || waitingJobCount > 0) {
      this.logger.log(
        `Skipping daily sync entirely — ${activeJobCount} active and ${waitingJobCount} waiting job(s) in queue (likely an ongoing import).`,
      );
      return;
    }

    // Auto-reset stuck profiles: if the queue is empty but some profiles
    // are still marked SYNCING, a previous run crashed mid-sync.
    const stuckProfiles = await this.profileRepo.find({
      where: { isActive: true, syncState: 'SYNCING' as any },
    });

    if (stuckProfiles.length > 0) {
      this.logger.warn(
        `Found ${stuckProfiles.length} profile(s) stuck in SYNCING with empty queue — resetting.`,
      );
      for (const sp of stuckProfiles) {
        await this.profileRepo.update(
          { profileId: sp.profileId },
          {
            syncState: 'FAILED',
            lastSyncError: 'Auto-reset: was stuck in SYNCING with empty queue',
          },
        );
      }
    }

    const activeProfiles = await this.profileRepo.find({
      where: { isActive: true },
    });

    let queued = 0;

    for (const profile of activeProfiles) {
      const latestSnapshot = await this.snapshotRepo.findOne({
        where: { profileId: profile.profileId },
        order: { date: 'DESC' },
      });

      let daysToFetch = 3;

      if (latestSnapshot) {
        const lastDate = new Date(latestSnapshot.date);
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);

        const diffTime = Math.abs(yesterday.getTime() - lastDate.getTime());
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        if (diffDays > 0) {
          daysToFetch = diffDays + 2;
        }
      }

      daysToFetch = Math.min(daysToFetch, 90);

      await this.profileRepo.update(
        { profileId: profile.profileId },
        { syncState: 'SYNCING' },
      );

      await this.syncQueue.add('initial-historical-sync', {
        profileId: profile.profileId,
        daysToFetch,
      });
      queued++;

      this.logger.log(
        `Queued daily sync for ${profile.profileId} (Fetching last ${daysToFetch} days)`,
      );
    }

    // Wait for all page-sync jobs to finish, then run comment-links.
    // Manual syncs skip this (only page data).
    if (queued > 0 && !options?.skipCommentLinks) {
      await this.waitForQueueIdle();
      this.logger.log('All page syncs finished. Starting comment-links scan...');
      await this.runCommentLinksSync();
    }
  }

  /**
   * Scans top comments for links on recent posts across all active
   * Facebook pages. Runs after page sync is fully complete.
   */
  private async runCommentLinksSync() {
    const fbProfiles = await this.profileRepo.find({
      where: { platform: 'facebook' as any, isActive: true },
    });

    this.logger.log(
      `Comment-links: scanning ${fbProfiles.length} Facebook page(s)...`,
    );

    let pagesProcessed = 0;

    for (const profile of fbProfiles) {
      try {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const recentPosts = await this.postRepo.find({
          where: {
            platform: 'facebook' as any,
            profileId: profile.profileId,
            postedAt: MoreThanOrEqual(sevenDaysAgo),
          },
          order: { postedAt: 'DESC' },
        });

        if (recentPosts.length > 0) {
          await this.commentLinksService.processPosts(
            recentPosts,
            profile.profileId,
            profile.name,
            profile.accessToken,
          );
        }
      } catch (err: any) {
        this.logger.error(
          `Comment-links failed for ${profile.profileId}: ${err.message}`,
        );
      }

      pagesProcessed++;

      // 5-second breather between pages to stay under rate limits
      if (pagesProcessed < fbProfiles.length) {
        await this.sleep(5000);
      }
    }

    this.logger.log(
      `Comment-links scan complete for ${pagesProcessed} page(s).`,
    );
  }

  /** Polls queue until idle. Gives up after 60 minutes. */
  private async waitForQueueIdle() {
    const maxWaitMs = 60 * 60 * 1000;
    const pollIntervalMs = 15_000;
    const waitStart = Date.now();

    while (Date.now() - waitStart < maxWaitMs) {
      const active = await this.syncQueue.getActiveCount();
      const waiting = await this.syncQueue.getWaitingCount();
      if (active === 0 && waiting === 0) return;
      await this.sleep(pollIntervalMs);
    }

    this.logger.warn('Queue did not drain within 60 minutes. Skipping comment-links.');
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
