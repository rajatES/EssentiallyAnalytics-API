import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';

import { PostLinkComment } from './entities/post-link-comment.entity';
import { SocialProfile } from '../facebook/entities/SocialProfile.entity';
import { SocialPost } from '../facebook/entities/SocialPost.entity';

const BASE_URL = 'https://graph.facebook.com/v25.0';

@Injectable()
export class CommentLinksService {
  private readonly logger = new Logger(CommentLinksService.name);

  constructor(
    @InjectRepository(PostLinkComment)
    private readonly postLinkCommentRepo: Repository<PostLinkComment>,
    @InjectRepository(SocialProfile)
    private readonly profileRepo: Repository<SocialProfile>,
    @InjectRepository(SocialPost)
    private readonly postRepo: Repository<SocialPost>,
  ) {}

  /**
   * Processes an array of posts, fetches their top comment, and saves the link data.
   * Can be called by the sync processor after fetching posts.
   */
  async processPosts(posts: { postId: string }[], profileId: string, accessToken: string) {
    if (!posts || posts.length === 0) return;

    // Find which posts we've already checked
    const checkedRecords = await this.postLinkCommentRepo.find({
      where: posts.map(p => ({ postId: p.postId })),
      select: ['postId'],
    });
    const checkedPostIds = new Set(checkedRecords.map(r => r.postId));

    const postsToCheck = posts.filter(p => !checkedPostIds.has(p.postId));

    if (postsToCheck.length === 0) return;

    this.logger.log(`Scanning top comments for ${postsToCheck.length} new posts for profile ${profileId}`);

    for (const post of postsToCheck) {
      await this.checkPostComment(post.postId, profileId, accessToken);
      // Small sleep to avoid rate limiting since we hit the API per post
      await this.sleep(800);
    }
  }

  /**
   * Backfills data for the last N days across all active Facebook pages.
   */
  async backfill(daysBack: number = 60) {
    try {
      this.logger.log(`Starting comment links backfill for the last ${daysBack} days`);
      const activeProfiles = await this.profileRepo.find({
        where: { platform: 'facebook', isActive: true },
      });

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysBack);

      for (const profile of activeProfiles) {
        const recentPosts = await this.postRepo.find({
          where: {
            platform: 'facebook',
            profileId: profile.profileId,
            postedAt: MoreThanOrEqual(startDate),
          },
          order: { postedAt: 'DESC' },
        });

        await this.processPosts(recentPosts, profile.profileId, profile.accessToken);
      }
      this.logger.log(`Completed comment links backfill for the last ${daysBack} days`);
    } catch (error: any) {
      this.logger.error(`Error in backfill: ${error.message}`);
    }
  }

  private async checkPostComment(postId: string, profileId: string, accessToken: string) {
    try {
      const url = `${BASE_URL}/${postId}/comments?limit=1&order=chronological&fields=id,message,attachment&access_token=${accessToken}`;
      const response = await axios.get(url);
      
      const comments = response.data?.data || [];

      // TEMPORARY LOG FOR USER VERIFICATION
      this.logger.log(`\n\n--- RAW API RESPONSE FOR POST ${postId} ---`);
      console.dir(response.data, { depth: null });

      const topComment = comments.length > 0 ? comments[0] : null;

      let hasLink = false;
      let linkUrl: string | null = null;
      let commentMessage: string | null = null;
      let commentId: string | null = null;

      if (topComment) {
        commentId = topComment.id;
        commentMessage = topComment.message || '';

        // 1. Check for URL in message text
        const urlRegex = /(https?:\/\/[^\s]+)/;
        const match = commentMessage ? commentMessage.match(urlRegex) : null;
        if (match) {
          hasLink = true;
          linkUrl = match[1];
        }

        // 2. Check attachment if no text link found
        if (!hasLink && topComment.attachment) {
          const attach = topComment.attachment;
          if (attach.type === 'share' && attach.url) {
            hasLink = true;
            linkUrl = attach.url;
          }
        }
      }

      const record = new PostLinkComment();
      record.postId = postId;
      record.profileId = profileId;
      record.commentId = commentId || '';
      record.commentMessage = commentMessage || '';
      record.hasLink = hasLink;
      record.linkUrl = linkUrl || '';

      // TEMPORARY LOG FOR USER VERIFICATION
      this.logger.log(`\n--- PARSED DATA FOR DB ---`);
      console.dir({
        postId: record.postId,
        commentId: record.commentId,
        commentMessage: record.commentMessage,
        hasLink: record.hasLink,
        linkUrl: record.linkUrl,
      }, { depth: null });
      this.logger.log(`-------------------------------------------\n\n`);

      await this.postLinkCommentRepo.save(record);
    } catch (error: any) {
      this.logger.warn(`Failed to check comments for post ${postId}: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
