import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * One row per Critical Flow content piece, sourced from the aggregated
 * "Critical Flow Integrated DB" sheet that the n8n workflow builds out of the
 * per-division source workbooks.
 *
 * The lifecycle this captures is NOT the MSN one. A piece is allotted, written
 * and submitted, then goes through a first editorial pass; if that pass sends
 * it back, a second pass follows. Publication is recorded as a date (the WP
 * columns exist in the source but are almost never filled in).
 */
@Entity('cf_pieces')
export class CfPiece {
  @PrimaryColumn()
  id: string;

  /** division|title — stable across re-allotments of the same headline. */
  @Column({ type: 'text', default: '' })
  uniquePieceId: string;

  // ── Dimensions ──

  /** Sport/division, e.g. "NFL", "College Football", "NASCAR". */
  @Index()
  @Column({ default: 'Unknown' })
  division: string;

  /** Source month tab, e.g. "September 2026". */
  @Index()
  @Column({ default: '' })
  month: string;

  @Index()
  @Column({ default: 'Unknown' })
  writer: string;

  /** First-pass editor. */
  @Index()
  @Column({ default: 'Unknown' })
  editor: string;

  /** Second-pass editor — only set on pieces that went back for rework. */
  @Index()
  @Column({ default: '' })
  editor2: string;

  @Index()
  @Column({ default: 'Unknown' })
  allottedBy: string;

  /** "Trend Setter" | "In-Depth" | "Quick Hit" | … */
  @Index()
  @Column({ default: 'Unknown' })
  articleType: string;

  /**
   * Whether the piece is flagged for Yahoo/Newsbreak syndication. Null when the
   * source cell is blank — distinct from an explicit "No".
   */
  @Index()
  @Column({ type: 'boolean', nullable: true })
  yahoo: boolean | null;

  // ── Status ──

  @Index()
  @Column({ default: 'Unknown' })
  editorialStatus: string;

  @Column({ default: '' })
  editorialStatus2: string;

  /** Send-back reason taxonomy, e.g. "Robotic Writing", "Lack of BBT (Context)". */
  @Index()
  @Column({ default: '' })
  sbReason: string;

  @Column({ default: '' })
  wpStatus: string;

  // ── Lifecycle timestamps ──

  @Column({ type: 'timestamptz', nullable: true })
  allottedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  /** Submission restated in EST by the source sheet; kept for cross-checks. */
  @Column({ type: 'timestamptz', nullable: true })
  submittedEst: Date | null;

  /** First editorial pass completed. */
  @Column({ type: 'timestamptz', nullable: true })
  editorAt: Date | null;

  /** Second editorial pass completed (post send-back). */
  @Column({ type: 'timestamptz', nullable: true })
  editorAt2: Date | null;

  /** Actual WP go-live stamp. Rarely populated in the source. */
  @Column({ type: 'timestamptz', nullable: true })
  liveAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  wpCheckedAt: Date | null;

  /** Publication date as recorded by the sheet's "Date EST" column. */
  @Index()
  @Column({ type: 'date', nullable: true })
  publishedDate: string | null;

  /** Date-only anchor (allotment day, falling back through the lifecycle). */
  @Index()
  @Column({ type: 'date', nullable: true })
  date: string | null;

  // ── Durations (hours) ──

  /** End-to-end turnaround as computed by the source sheet. */
  @Column({ type: 'real', nullable: true })
  tatHours: number | null;

  /** Time spent in the send-back loop. */
  @Column({ type: 'real', nullable: true })
  sbHours: number | null;

  // ── Text / metadata ──

  @Column({ type: 'text', default: '' })
  title: string;

  /** Normalised title, for duplicate detection. */
  @Index()
  @Column({ type: 'text', default: '' })
  titleNorm: string;

  @Column({ type: 'text', default: '' })
  source: string;

  @Column({ type: 'text', default: '' })
  stagingLink: string;

  @Column({ type: 'text', default: '' })
  writerComments: string;

  @Column({ type: 'text', default: '' })
  editorComment: string;

  @Column({ type: 'text', default: '' })
  editorComment2: string;

  @Column({ type: 'text', default: '' })
  articleMap: string;

  @Column({ type: 'text', default: '' })
  plagReport: string;

  // ── Change detection / audit ──

  @Column({ type: 'text', default: '' })
  rawHash: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
