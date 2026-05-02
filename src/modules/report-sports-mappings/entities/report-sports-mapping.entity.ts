import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('report_sports_mappings')
export class ReportSportsMapping {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  profileId: string; // Social profile ID (from social_profiles table)

  @Column()
  pageName: string;

  @Column({ nullable: true })
  sport: string | null; // e.g., "Cricket", "Football", "Hockey"

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
