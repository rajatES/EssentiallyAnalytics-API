import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

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
  commentId: string;

  @Column({ type: 'text', nullable: true })
  commentMessage: string;

  @Column({ type: 'boolean', default: false })
  hasLink: boolean;

  @Column({ type: 'text', nullable: true })
  linkUrl: string;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  checkedAt: Date;
}
