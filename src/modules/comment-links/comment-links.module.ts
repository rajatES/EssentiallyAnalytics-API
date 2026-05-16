import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CommentLinksService } from './comment-links.service';
import { CommentLinksController } from './comment-links.controller';
import { PostLinkComment } from './entities/post-link-comment.entity';
import { SocialProfile } from '../facebook/entities/SocialProfile.entity';
import { SocialPost } from '../facebook/entities/SocialPost.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([PostLinkComment, SocialProfile, SocialPost]),
  ],
  controllers: [CommentLinksController],
  providers: [CommentLinksService],
  exports: [CommentLinksService],
})
export class CommentLinksModule {}
