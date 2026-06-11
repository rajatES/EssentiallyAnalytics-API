import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * One row per content piece, sourced from the integrated MSN sheet.
 * Captures the full lifecycle (allotment → pick → submit → verify → publish)
 * in a single record keyed on the sheet's native `ID`.
 */
@Entity('msn_pieces')
export class MsnPiece {
  @PrimaryColumn()
  id: string;

  @Column({ type: 'text', default: '' })
  uniquePieceId: string;

  // ── Dimensions ──

  @Index()
  @Column({ default: 'Unknown' })
  category: string;

  @Index()
  @Column({ default: 'Unknown' })
  feed: string;

  @Index()
  @Column({ default: 'Unknown' })
  writer: string;

  @Index()
  @Column({ default: 'Unknown' })
  editor: string;

  @Index()
  @Column({ default: 'Unknown' })
  allottedBy: string;

  @Index()
  @Column({ default: 'Unknown' })
  contentType: string;

  // ── Status ──

  @Index()
  @Column({ default: 'Unknown' })
  publishingStatus: string;

  @Index()
  @Column({ default: 'Unknown' })
  editorialStatus: string;

  // ── Metrics ──

  @Column({ type: 'int', nullable: true })
  slides: number | null;

  // ── Lifecycle timestamps ──

  @Column({ type: 'timestamptz', nullable: true })
  allottedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  pickedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  verifyStart: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  verifyEnd: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  /** Date-only key (derived from allottedAt) used for filtering & bucketing. */
  @Index()
  @Column({ type: 'date', nullable: true })
  date: string | null;

  // ── Text / metadata ──

  @Column({ type: 'text', default: '' })
  title: string;

  @Column({ type: 'text', default: '' })
  pickedBy: string;

  @Column({ type: 'text', default: '' })
  primarySource: string;

  @Column({ type: 'text', default: '' })
  sourcesUsed: string;

  @Column({ type: 'text', default: '' })
  stagingLink: string;

  @Column({ type: 'text', default: '' })
  featuredImage: string;

  @Column({ type: 'text', default: '' })
  feedback: string;

  @Column({ type: 'text', default: '' })
  comments: string;

  // ── Change detection / audit ──

  @Column({ type: 'text', default: '' })
  rawHash: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
