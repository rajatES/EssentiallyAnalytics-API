import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { ProductionPiece } from '../../production/production-piece';

/**
 * One row per Yahoo content piece, sourced from the aggregated "Yahoo
 * Production DB" sheet that the n8n workflow builds out of the single Yahoo
 * source workbook.
 *
 * The lifecycle is Critical Flow's minus the rework loop: a piece is allotted,
 * written and submitted, then a newsroom editor takes one pass and publishes
 * it. There is no send-back, no second pass and no second editor, so the
 * second-pass fields of {@link ProductionPiece} are simply absent here rather
 * than present and permanently empty.
 *
 * Two mappings are worth knowing when reading these numbers:
 *
 * - **`editorAt` is the automated publishing stamp.** The source records no
 *   separate "editor finished" time, and in a single-pass pipeline publication
 *   *is* the end of the editorial pass, so the two are the same event. This is
 *   what makes the submission → editorial leg measurable at all.
 * - **Allotment carries a real clock time**, assembled by the workflow from the
 *   source's separate date and time cells. Unlike Critical Flow, writing time
 *   here is genuinely measured rather than inferred from midnight.
 */
@Entity('yp_pieces')
export class YpPiece implements ProductionPiece {
  @PrimaryColumn()
  id: string;

  /** division|title — stable across re-allotments of the same headline. */
  @Column({ type: 'text', default: '' })
  uniquePieceId: string;

  // ── Dimensions ──

  @Index()
  @Column({ default: 'Unknown' })
  division: string;

  /** Source month tab, e.g. "Sept 2026". */
  @Index()
  @Column({ default: '' })
  month: string;

  @Index()
  @Column({ default: 'Unknown' })
  writer: string;

  /** The newsroom editor who handled the piece ("NR/NR equivalent"). */
  @Index()
  @Column({ default: 'Unknown' })
  editor: string;

  @Index()
  @Column({ default: 'Unknown' })
  allottedBy: string;

  /** "In-Depth" | "Urgent" | … */
  @Index()
  @Column({ default: 'Unknown' })
  articleType: string;

  /** "Enhanced" / "Enhancements Not Needed" — Yahoo's own quality flag. */
  @Index()
  @Column({ default: '' })
  enhancement: string;

  // ── Status ──

  @Index()
  @Column({ default: 'Unknown' })
  editorialStatus: string;

  @Column({ default: '' })
  wpStatus: string;

  // ── Lifecycle timestamps ──

  /** Allotment date joined with the hand-typed allotment clock. */
  @Column({ type: 'timestamptz', nullable: true })
  allottedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  /** Publication — and, in this single-pass pipeline, the editorial pass. */
  @Column({ type: 'timestamptz', nullable: true })
  editorAt: Date | null;

  /** Actual WP go-live stamp. Filled on a handful of rows only. */
  @Column({ type: 'timestamptz', nullable: true })
  liveAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  wpCheckedAt: Date | null;

  @Index()
  @Column({ type: 'date', nullable: true })
  publishedDate: string | null;

  /** Date-only anchor: the source's Work Date, falling forward if blank. */
  @Index()
  @Column({ type: 'date', nullable: true })
  date: string | null;

  // ── Durations (hours) ──

  /** Allotment → publication, derived by the workflow; the source has no TAT. */
  @Column({ type: 'real', nullable: true })
  tatHours: number | null;

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
  plagReport: string;

  // ── Change detection / audit ──

  @Column({ type: 'text', default: '' })
  rawHash: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
