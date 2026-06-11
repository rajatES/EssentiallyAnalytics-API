import { Entity, Column, PrimaryColumn, Index } from 'typeorm';

/**
 * One row per moderation check, sourced from the external moderation tool's
 * log sheet. A title can appear many times (re-checks); rows are keyed on a
 * hash of (timestamp, title, user).
 */
@Entity('msn_moderation')
export class MsnModerationRow {
  @PrimaryColumn()
  id: string;

  @Index()
  @Column({ type: 'timestamptz', nullable: true })
  checkedAt: Date | null;

  @Column({ type: 'text', default: '' })
  title: string;

  /**
   * Normalized title (lowercase, collapsed whitespace) for cross-sheet
   * matching. Deliberately NOT indexed — some sheet rows carry multi-KB
   * "titles" that exceed Postgres' btree row-size limit, and matching is
   * done in memory anyway.
   */
  @Column({ type: 'text', default: '' })
  titleNorm: string;

  @Index()
  @Column({ default: 'Unknown' })
  checkedBy: string;

  @Column({ default: 'Unknown' })
  feed: string;

  /** Content format per the moderation tool (Article / Slideshow). */
  @Column({ default: 'Unknown' })
  category: string;

  @Column({ type: 'int', nullable: true })
  riskRating: number | null;

  @Column({ default: false })
  overallResult: boolean;

  /** Code-check rejection reason (set when the title never reached the AI). */
  @Column({ type: 'text', default: '' })
  reason: string;

  // ── Per-dimension outcomes: PASS / FAIL / SKIP / '' ──

  @Column({ default: '' })
  tbScore: string;

  @Column({ default: '' })
  legalScore: string;

  @Column({ default: '' })
  feedScore: string;

  @Column({ default: '' })
  subjectiveScore: string;

  @Column({ type: 'text', default: '' })
  rawHash: string;
}
