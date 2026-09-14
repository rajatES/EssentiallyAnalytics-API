import { Entity, Column, PrimaryColumn, Index } from 'typeorm';

/**
 * One leave record from the "CF Writer Leaves" / "CF Editor Leaves" logs.
 * Keyed on name only — the logs' Division column holds a role tag
 * ("CF - Editor"), not the sport.
 */
@Entity('cf_leave')
export class CfLeave {
  /** hash(loggedAt | name | leaveStart) */
  @PrimaryColumn()
  id: string;

  @Index()
  @Column()
  name: string;

  /** "writer" | "editor" — which log it came from. */
  @Column({ default: '' })
  roleTag: string;

  @Column({ type: 'date' })
  leaveStart: string;

  @Column({ type: 'date' })
  leaveEnd: string;

  @Column({ type: 'real', nullable: true })
  days: number | null;

  @Column({ default: '' })
  type: string;

  @Column({ type: 'timestamptz', nullable: true })
  loggedAt: Date | null;

  @Column({ default: '' })
  rawHash: string;
}
