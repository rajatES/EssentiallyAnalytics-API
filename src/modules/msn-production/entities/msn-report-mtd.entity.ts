import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One row per (month, publication) from the month-to-date scraper.
 * `month` is the first day of the month (ISO yyyy-mm-01); `asOf` is the
 * last day covered by the most recent run, so within a month the same row
 * keeps advancing. Same non-zero merge semantics as the other reports.
 */
@Entity('msn_report_mtd')
export class MsnReportMtd {
  @PrimaryColumn({ type: 'date' })
  month: string;

  @PrimaryColumn()
  publication: string;

  /** End of the window the stored values describe (usually yesterday). */
  @Column({ type: 'date', nullable: true })
  asOf: string | null;

  @Column({ type: 'bigint', nullable: true })
  articleViews: string | null;

  @Column({ type: 'bigint', nullable: true })
  slideshowViews: string | null;

  @Column({ type: 'bigint', nullable: true })
  videoViews: string | null;

  @Column({ type: 'float', nullable: true })
  videoConsumedHours: number | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
