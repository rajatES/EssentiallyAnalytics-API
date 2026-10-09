import { Controller, Post, Body, Res, Get } from '@nestjs/common';
import type { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, IsNull, Not } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { SocialProfile } from '../entities/SocialProfile.entity';
import { AnalyticsSnapshot } from '../entities/AnalyticsSnapshot.entity';
import { SocialPost } from '../entities/SocialPost.entity';
import { DemographicSnapshot } from '../entities/DemographicSnapshot.entity';
import { DailyRevenue } from '../../revenue/entities/daily-revenue.entity';
import { RevenueMapping } from '../../revenue/entities/revenue-mapping.entity';
import { PostLinkComment } from '../../comment-links/entities/post-link-comment.entity';
import {
  exchangeForLongLivedToken,
  fetchLinkedInstagramAccounts,
  fetchPermanentPageTokens,
  fetchTokenOwner,
} from '../services/meta.service';
import { MinRole } from '../../../common/decorators/min-role.decorator';
import { UserRole } from '../../auth/entities/user.entity';
import { Section } from '../../../common/decorators/section.decorator';

// Disconnect key for profiles connected before connectedViaId was recorded.
const LEGACY_GRANTOR = 'legacy';

@Controller('api/auth/meta')
@Section('sm')
export class AuthController {
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
    @InjectRepository(PostLinkComment)
    private postLinkCommentRepo: Repository<PostLinkComment>,
    @InjectQueue('social-sync-queue') private syncQueue: Queue,
  ) {}

  @MinRole(UserRole.MANAGEMENT)
  @Post('fetch-pages')
  async fetchPages(
    @Body() body: { shortLivedToken: string },
    @Res() res: Response,
  ) {
    try {
      const { shortLivedToken } = body;
      const longLivedToken = await exchangeForLongLivedToken(shortLivedToken);
      const grantor = await fetchTokenOwner(longLivedToken);
      const pages = await fetchPermanentPageTokens('me', longLivedToken);

      const igAccounts = await fetchLinkedInstagramAccounts(pages);

      return res.status(200).json({ pages, igAccounts, grantor });
    } catch (error: any) {
      console.error('Fetch Pages Error:', error);
      return res.status(500).json({ error: 'Failed to fetch Meta accounts' });
    }
  }

  @MinRole(UserRole.MANAGEMENT)
  @Post('confirm-pages')
  async confirmPages(
    @Body()
    body: {
      selectedPages?: any[];
      selectedIgAccounts?: any[];
      grantor?: { id: string; name: string } | null;
    },
    @Res() res: Response,
  ) {
    try {
      const { selectedPages = [], selectedIgAccounts = [], grantor } = body;
      const connectedViaId = grantor?.id ? String(grantor.id) : null;
      const connectedViaName = grantor?.name ?? null;

      const profilePayloads: any[] = [];

      selectedPages.forEach((page: any) => {
        profilePayloads.push({
          profileId: page.id,
          name: page.name,
          platform: 'facebook',
          accessToken: page.access_token,
          isActive: true,
          connectedViaId,
          connectedViaName,
        });
      });

      selectedIgAccounts.forEach((ig: any) => {
        profilePayloads.push({
          profileId: ig.id,
          name: ig.name,
          // The only identifier that resolves as an instagram.com URL — the
          // account id in `profileId` does not. Captured here because this is
          // the one place Meta hands it to us for free.
          username: ig.username ?? null,
          platform: 'instagram',
          accessToken: ig.access_token,
          isActive: true,
          connectedViaId,
          connectedViaName,
        });
      });

      // Re-running connect with the same Facebook account still narrows what it
      // tracks — anything it granted before but left unticked stops syncing.
      // Pages granted by other accounts are not this login's to drop.
      if (connectedViaId && profilePayloads.length > 0) {
        await this.profileRepo.update(
          {
            connectedViaId,
            isActive: true,
            profileId: Not(In(profilePayloads.map((p) => p.profileId))),
          },
          { isActive: false },
        );
      }

      if (profilePayloads.length > 0) {
        await this.profileRepo.upsert(profilePayloads, ['profileId']);

        const eightyFiveDaysAgo = new Date();
        eightyFiveDaysAgo.setDate(eightyFiveDaysAgo.getDate() - 85);

        for (const profile of profilePayloads) {
          const oldestSnapshot = await this.snapshotRepo.findOne({
            where: { profileId: profile.profileId },
            order: { date: 'ASC' },
          });

          let needsSync = true;
          if (oldestSnapshot) {
            const oldestDate = new Date(oldestSnapshot.date);
            if (oldestDate <= eightyFiveDaysAgo) {
              needsSync = false;
            }
          }

          if (needsSync) {
            await this.profileRepo.update(
              { profileId: profile.profileId },
              { syncState: 'SYNCING' },
            );
            await this.syncQueue.add(
              'initial-historical-sync',
              { profileId: profile.profileId },
              { attempts: 3, backoff: 5000 },
            );
          } else {
            await this.profileRepo.update(
              { profileId: profile.profileId },
              { syncState: 'COMPLETED' },
            );
          }
        }
      }
      return res.status(200).json({
        success: true,
        message:
          'Pages and Accounts connected successfully. Data sync processed.',
      });
    } catch (error: any) {
      console.error('Confirm Pages Error:', error);
      return res.status(500).json({ error: 'Failed to save Meta accounts' });
    }
  }

  @MinRole(UserRole.MANAGEMENT)
  @Post('disconnect')
  async disconnectMeta(
    @Body()
    body: {
      deleteData: boolean;
      platform?: 'facebook' | 'instagram' | 'all';
      // Limits the disconnect to the pages one Facebook account granted;
      // LEGACY_GRANTOR targets rows connected before grantors were recorded.
      connectedViaId?: string;
    },
    @Res() res: Response,
  ) {
    try {
      const { deleteData, platform = 'all', connectedViaId } = body;

      const platformQuery =
        platform === 'all' ? In(['facebook', 'instagram']) : platform;

      const profiles = await this.profileRepo.find({
        where: {
          platform: platformQuery,
          ...(connectedViaId
            ? {
                connectedViaId:
                  connectedViaId === LEGACY_GRANTOR ? IsNull() : connectedViaId,
              }
            : {}),
        },
      });
      const profileIds = profiles.map((p) => p.profileId);

      if (connectedViaId && profileIds.length === 0) {
        return res
          .status(404)
          .json({ error: 'No pages are connected through that account' });
      }

      // A per-account disconnect must not touch other accounts' rows, so it
      // scopes by profile; a full disconnect keeps sweeping by platform.
      const scope: any = connectedViaId
        ? { profileId: In(profileIds) }
        : { platform: platformQuery };

      if (profileIds.length > 0) {
        const jobs = await this.syncQueue.getJobs([
          'waiting',
          'active',
          'delayed',
          'paused',
        ]);
        for (const job of jobs) {
          if (job.data && profileIds.includes(job.data.profileId)) {
            try {
              await job.remove();
            } catch (err) {}
          }
        }
      }

      if (deleteData) {
        // Delete revenue data for the affected Facebook pages
        if (platform === 'all' || platform === 'facebook') {
          const fbProfiles = profiles.filter((p) => p.platform === 'facebook');
          const fbPageIds = fbProfiles.map((p) => p.profileId);
          if (fbPageIds.length > 0) {
            await this.dailyRevenueRepo.delete({ pageId: In(fbPageIds) });
            await this.revenueMappingRepo.delete({ pageId: In(fbPageIds) });
          }
        }

        // Comment content pulled from Meta lives here; it has no platform
        // column, so scope it by the profiles being removed. Must be deleted
        // for the "Delete all historical data" claim in our published data
        // deletion instructions to hold true.
        if (profileIds.length > 0) {
          await this.postLinkCommentRepo.delete({ profileId: In(profileIds) });
        }

        await this.demographicRepo.delete(scope);
        await this.snapshotRepo.delete(scope);
        await this.postRepo.delete(scope);
        await this.profileRepo.delete(scope);
      } else {
        await this.profileRepo.update(scope, {
          isActive: false,
          syncState: 'DISCONNECTED',
        });
      }

      const target = connectedViaId
        ? `${profileIds.length} profile(s)`
        : platform;
      return res.status(200).json({
        success: true,
        removed: profileIds.length,
        message: deleteData
          ? `Successfully disconnected and deleted data for ${target}.`
          : `Successfully disconnected ${target} accounts.`,
      });
    } catch (error: any) {
      console.error('Disconnect Meta Error:', error);
      return res
        .status(500)
        .json({ error: 'Failed to disconnect Meta accounts' });
    }
  }

  @Get('sync-status')
  async getSyncStatus(@Res() res: Response) {
    const active = await this.syncQueue.getActiveCount();
    const waiting = await this.syncQueue.getWaitingCount();
    const totalJobs = active + waiting;

    return res.status(200).json({
      isSyncing: totalJobs > 0,
      jobsRemaining: totalJobs,
    });
  }
}
