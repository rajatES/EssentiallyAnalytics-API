import { Controller, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CommentLinksService } from './comment-links.service';

@Controller('comment-links')
export class CommentLinksController {
  constructor(private readonly commentLinksService: CommentLinksService) {}

  @Post('backfill')
  async triggerBackfill(@Query('days') daysStr: string, @Res() res: Response) {
    try {
      const days = parseInt(daysStr) || 60;
      // Start the backfill process asynchronously so the request doesn't block
      this.commentLinksService.backfill(days).catch(err => {
        console.error('Backfill error:', err);
      });
      return res.status(200).json({ message: `Started comment links backfill for the last ${days} days` });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }
}
