import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One row per (weekStart, publication) from the weekly (EOW) scraper.
 * The 7-day window is weekStart..weekEnd inclusive; weekStart alone
 * identifies the window because the scraper always uses a fixed 7-day span.
 * Same non-zero merge semantics as the EOD report.
 */
@Entity('msn_report_eow')
export class MsnReportEow {
  @PrimaryColumn({ type: 'date' })
  weekStart: string;

  @PrimaryColumn()
  publication: string;

  @Column({ type: 'date' })
  weekEnd: string;

  @Column({ type: 'int', nullable: true })
  articlePublished: number | null;

  @Column({ type: 'bigint', nullable: true })
  articleViews: string | null;

  @Column({ type: 'int', nullable: true })
  slideshowPublished: number | null;

  @Column({ type: 'bigint', nullable: true })
  slideshowViews: string | null;

  @Column({ type: 'int', nullable: true })
  videoPublished: number | null;

  @Column({ type: 'bigint', nullable: true })
  videoViews: string | null;

  @Column({ type: 'float', nullable: true })
  videoConsumedHours: number | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
