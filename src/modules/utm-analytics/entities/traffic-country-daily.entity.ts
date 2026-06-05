import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('traffic_country_daily')
@Index(['date', 'utmSource'])
export class TrafficCountryDaily {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column({ unique: true })
  dimensionHash: string;

  @Column({ type: 'date' })
  date: string;

  @Column({ default: '(direct)' })
  utmSource: string;

  @Column({ default: 'Unknown' })
  country: string;

  @Column({ type: 'int', default: 0 })
  sessions: number;
}
