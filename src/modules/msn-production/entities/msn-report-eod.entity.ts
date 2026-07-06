import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * One row per (date, publication) from the EOD syndication scraper.
 * Re-runs for the same key are merged field-by-field: an incoming
 * non-zero/non-blank value overwrites; a zero/blank incoming value keeps
 * whatever is already stored, so data only ever improves across runs.
 */
@Entity('msn_report_eod')
export class MsnReportEod {
  /** Report date (the day the metrics describe), ISO yyyy-mm-dd. */
  @PrimaryColumn({ type: 'date' })
  date: string;

  @PrimaryColumn()
  publication: string;

  // ── Meta metrics ──

  @Column({ type: 'bigint', nullable: true })
  followers: string | null;

  /** Percentages stored as numbers (98 for "98%"). */
  @Column({ type: 'float', nullable: true })
  feedHealthRate: number | null;

  @Column({ type: 'float', nullable: true })
  publishRate: number | null;

  // ── Published counts (unique titles per type) ──

  @Column({ type: 'int', nullable: true })
  publishedVideo: number | null;

  @Column({ type: 'int', nullable: true })
  publishedGallery: number | null;

  @Column({ type: 'int', nullable: true })
  publishedArticle: number | null;

  @Column({ type: 'int', nullable: true })
  publishedTotal: number | null;

  // ── Views: { Article|Gallery|Video: { USA|UK|...: number } } ──

  @Column({ type: 'jsonb', default: () => "'{}'" })
  views: Record<string, Record<string, number>>;

  // ── Per-feed health rows: [{ region, type, reliability, publishRate }] ──

  @Column({ type: 'jsonb', default: () => "'[]'" })
  feedList: Array<{
    region: string;
    type: string;
    reliability: string;
    publishRate: string;
  }>;

  @Index()
  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
