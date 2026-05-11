import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

export type PostLinkCommentStatus = 'LINK' | 'FETCH_FAILED';

@Entity('post_link_comments')
@Index(['postId'], { unique: true })
export class PostLinkComment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  postId: string;

  @Column()
  profileId: string;

  @Column({ nullable: true })
  pageName: string;

  @Column({ nullable: true })
  commentId: string;

  @Column({ type: 'text', nullable: true })
  commentMessage: string;

  // Nullable because FETCH_FAILED rows have no link URL.
  @Column({ type: 'text', nullable: true })
  linkUrl: string | null;

  // 'LINK' = top comment had a link; 'FETCH_FAILED' = Graph error, do not retry.
  // Filter `WHERE status = 'LINK'` to get the "link posts only" view.
  @Column({ type: 'varchar', length: 32, default: 'LINK' })
  status: PostLinkCommentStatus;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  checkedAt: Date;
}
