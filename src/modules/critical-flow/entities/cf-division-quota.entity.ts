import { Entity, Column, PrimaryColumn } from 'typeorm';

/**
 * A division's daily publishing quota per shift, from the schedule workbook's
 * "DailyDynamics" tab. One row per (division, subFeed) — US Sports arrives as
 * separate Tennis and Olympics rows.
 */
@Entity('cf_division_quota')
export class CfDivisionQuota {
  /** hash(division | subFeed) */
  @PrimaryColumn()
  id: string;

  @Column()
  division: string;

  @Column({ default: '' })
  subFeed: string;

  /** The label as the managers wrote it ("Combat", "Nascar"). */
  @Column({ default: '' })
  sourceName: string;

  @Column({ type: 'int', default: 0 })
  emp: number;

  @Column({ type: 'int', default: 0 })
  lnp: number;

  @Column({ type: 'int', default: 0 })
  total: number;

  /**
   * The "Operations" figure on the Editorial Chart tab, kept so the page can
   * show where the two tabs disagree instead of silently picking one.
   */
  @Column({ type: 'int', nullable: true })
  editorialChartTotal: number | null;

  @Column({ default: '' })
  poc: string;

  /** Vision | Pod | '' */
  @Column({ default: '' })
  architecture: string;

  @Column({ default: '' })
  rawHash: string;
}
