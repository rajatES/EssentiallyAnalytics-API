import { Entity, Column, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * The one thing the schedule workbook does not carry: a person's own daily
 * quota. Edited from the resources page (management+); the per-writer targets
 * the retired Division Info rosters recorded were carried over once. Everything
 * else about a person is read from the sheets.
 */
@Entity('cf_resource_profile')
export class ResProfile {
  /** `${division}|${name}` — the same key the resource board uses. */
  @PrimaryColumn()
  id: string;

  @Column()
  division: string;

  @Column()
  name: string;

  /** Null means "not set" — shown as such, never as 0. */
  @Column({ type: 'int', nullable: true })
  dailyQuota: number | null;

  @Column({ type: 'text', default: '' })
  notes: string;

  @UpdateDateColumn()
  updatedAt: Date;
}
