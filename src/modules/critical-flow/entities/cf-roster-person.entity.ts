import { Entity, Column, PrimaryColumn, Index } from 'typeorm';

/**
 * One person from a division's "Division Info" tab. The source lists people in
 * stacked blocks (leadership, then writers under their own header), which the
 * n8n workflow flattens into these rows.
 */
@Entity('cf_roster')
export class CfRosterPerson {
  @PrimaryColumn()
  id: string;

  @Index()
  @Column({ default: 'Unknown' })
  division: string;

  @Column()
  name: string;

  /** Free text — "Full Time Writer", "Primary Editor", "Sub Group Head", … */
  @Column({ default: '' })
  role: string;

  /** Coarse bucket derived from `role`: writer | editor | lead | other. */
  @Index()
  @Column({ default: 'other' })
  roleGroup: string;

  @Column({ default: '' })
  weekoff: string;

  @Column({ default: '' })
  shift: string;

  @Column({ default: '' })
  email: string;

  /** Expected daily output, where the division records one. */
  @Column({ type: 'real', nullable: true })
  dailyTarget: number | null;

  @Column({ default: '' })
  rawHash: string;
}
