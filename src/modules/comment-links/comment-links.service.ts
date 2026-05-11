import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual, In } from 'typeorm';
import axios from 'axios';

import { PostLinkComment } from './entities/post-link-comment.entity';
import { SocialProfile } from '../facebook/entities/SocialProfile.entity';
import { SocialPost } from '../facebook/entities/SocialPost.entity';

const BASE_URL = 'https://graph.facebook.com/v25.0';

// Catches:
//   - explicit URLs:    https://example.com/x, http://example.com
//   - www-prefixed:     www.example.com/x
//   - bare domains:     example.com/x, bit.ly/abc, tinyurl.com/xyz, t.co/abc, youtu.be/...
const URL_REGEX =
  /((?:https?:\/\/|www\.)[^\s]+|(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|ly|gl|at|in|me|us|tv|app|info|news|tech|fm|to|so|gg|sh|xyz|page|link|be)(?:\/[^\s]*)?)/i;

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
   * Processes an array of posts, fetches their top comment, and saves a row
   * only when the top comment contains a link. Posts whose top comment has
   * no link are NOT saved; any pre-existing stale row for them is removed.
   *
   * @param force  If true, re-checks every post in the list even if it was
   *               previously checked. If false (default), posts that already
   *               have a row in post_link_comments are skipped.
   */
  async processPosts(
    posts: { postId: string }[],
    profileId: string,
    pageName: string,
    accessToken: string,
    force: boolean = false,
  ) {
    if (!posts || posts.length === 0) return;

    let postsToCheck = posts;

    if (!force) {
      const checkedRecords = await this.postLinkCommentRepo.find({
        where: { postId: In(posts.map((p) => p.postId)) },
        select: ['postId'],
      });
      const checkedPostIds = new Set(checkedRecords.map((r) => r.postId));
      postsToCheck = posts.filter((p) => !checkedPostIds.has(p.postId));
    }

    if (postsToCheck.length === 0) return;

    this.logger.log(
      `Scanning top comments for ${postsToCheck.length} posts for profile ${profileId}${force ? ' (force=true)' : ''}`,
    );

    for (const post of postsToCheck) {
      await this.checkPostComment(post.postId, profileId, pageName, accessToken);
      // Small sleep to avoid rate limiting since we hit the API per post
      await this.sleep(800);
    }
  }

  /**
   * Backfills data for the last N days across all active Facebook pages.
   *
   * @param force If true, re-checks every post in the window regardless of
   *              whether it was previously checked. Use this to refresh data
   *              for the same date range (e.g. after a parser fix).
   */
  async backfill(daysBack: number = 60, force: boolean = false) {
    try {
      this.logger.log(
        `Starting comment links backfill for the last ${daysBack} days (force=${force})`,
      );
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

        await this.processPosts(
          recentPosts,
          profile.profileId,
          profile.name,
          profile.accessToken,
          force,
        );
      }
      this.logger.log(
        `Completed comment links backfill for the last ${daysBack} days`,
      );
    } catch (error: any) {
      this.logger.error(`Error in backfill: ${error.message}`);
    }
  }

  private async checkPostComment(
    postId: string,
    profileId: string,
    pageName: string,
    accessToken: string,
  ) {
    try {
      const url = `${BASE_URL}/${postId}/comments?limit=1&order=chronological&fields=id,message,attachment&access_token=${accessToken}`;
      const response = await axios.get(url);

      const comments = response.data?.data || [];
      const topComment = comments.length > 0 ? comments[0] : null;

      let hasLink = false;
      let linkUrl: string | null = null;
      let commentMessage: string | null = null;
      let commentId: string | null = null;

      if (topComment) {
        commentId = topComment.id;
        commentMessage = topComment.message || '';

        // 1. URL in message text (covers http(s)://, www., and bare domains)
        const match = commentMessage ? commentMessage.match(URL_REGEX) : null;
        if (match) {
          hasLink = true;
          linkUrl = match[1];
        }

        // 2. Attachment fallback (for cases where FB auto-detects the link)
        if (!hasLink && topComment.attachment) {
          const attach = topComment.attachment;
          if (attach.type === 'share' && attach.url) {
            hasLink = true;
            linkUrl = attach.url;
          }
        }

        // 3. Decode Facebook redirect URLs to their actual destination
        if (linkUrl && linkUrl.includes('l.facebook.com/l.php')) {
          try {
            const decoded = new URL(linkUrl).searchParams.get('u');
            if (decoded) linkUrl = decodeURIComponent(decoded);
          } catch {
            // leave linkUrl as-is if URL parsing fails
          }
        }
      }

      if (hasLink && linkUrl) {
        // Upsert: insert new or overwrite existing row for this postId
        await this.postLinkCommentRepo.upsert(
          {
            postId,
            profileId,
            pageName,
            commentId: commentId || '',
            commentMessage: commentMessage || '',
            linkUrl,
            status: 'LINK',
            checkedAt: new Date(),
          },
          ['postId'],
        );
      } else {
        // No link in top comment: remove any stale row so the table only
        // ever contains posts whose CURRENT top comment has a link.
        await this.postLinkCommentRepo.delete({ postId });
      }
    } catch (error: any) {
      const errMsg =
        error.response?.data?.error?.message || error.message || 'unknown';
      this.logger.warn(
        `Failed to check comments for post ${postId}: ${errMsg}`,
      );

      // Persist a FETCH_FAILED marker so this post isn't retried on every
      // future sync. Common causes: post deleted, page lost permissions,
      // post type doesn't support the comments endpoint. None of these
      // resolve themselves — permanent skip is the right default.
      try {
        await this.postLinkCommentRepo.upsert(
          {
            postId,
            profileId,
            pageName,
            commentId: '',
            commentMessage: `<fetch_failed: ${errMsg.slice(0, 200)}>`,
            linkUrl: null,
            status: 'FETCH_FAILED',
            checkedAt: new Date(),
          },
          ['postId'],
        );
      } catch (saveErr: any) {
        this.logger.warn(
          `Could not record FETCH_FAILED marker for post ${postId}: ${saveErr.message}`,
        );
      }
    }
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
