import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

/**
 * Sessions broken down by the page they landed on, per day and traffic source.
 *
 * Exists because `traffic_daily` is keyed by utm_medium, which says nothing
 * useful for untagged organic traffic — every organic Reddit session has
 * medium 'referral', so the whole channel collapses into one row. The landing
 * page is the only dimension that separates that traffic into something
 * readable ("which article did Reddit send people to").
 *
 * Grain is (date, utmSource, pagePath). Only sources belonging to a known
 * platform are stored, which keeps this at roughly 850 rows/day rather than the
 * ~28k/day the unfiltered dataset would produce.
 */
@Entity('traffic_page_daily')
@Index(['date', 'utmSource'])
export class TrafficPageDaily {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column({ unique: true })
  dimensionHash: string;

  @Index()
  @Column({ type: 'date' })
  date: string;

  @Column({ default: '(direct)' })
  utmSource: string;

  /** Path only — query string and fragment are stripped upstream. */
  @Column({ type: 'text' })
  pagePath: string;

  @Column({ type: 'int', default: 0 })
  sessions: number;

  @Column({ type: 'int', default: 0 })
  pageviews: number;

  @Column({ type: 'int', default: 0 })
  users: number;
}
