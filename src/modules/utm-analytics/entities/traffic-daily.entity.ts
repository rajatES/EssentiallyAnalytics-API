import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('traffic_daily')
@Index(['date', 'utmSource', 'utmMedium'])
export class TrafficDaily {
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

  @Index()
  @Column({ default: '(none)' })
  utmMedium: string;

  @Column({ default: '(not set)' })
  utmCampaign: string;

  @Column({ type: 'int', default: 0 })
  sessions: number;

  @Column({ type: 'int', default: 0 })
  pageviews: number;

  @Column({ type: 'int', default: 0 })
  users: number;

  @Column({ type: 'int', default: 0 })
  newUsers: number;

  @Column({ type: 'int', default: 0 })
  recurringUsers: number;

  @Column({ type: 'int', default: 0 })
  identifiedUsers: number;

  @Column({ type: 'int', default: 0 })
  eventCount: number;

  @Column({ type: 'decimal', precision: 5, scale: 4, default: 0 })
  engagementRate: number;
}
