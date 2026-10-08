import { Entity, Column, PrimaryColumn } from 'typeorm';

/**
 * The Stable desk, from the workbook's own "Daily Schedule" tab. The desk is
 * one team working every event, so nobody here belongs to a single event.
 * Contact numbers are deliberately not copied.
 */
@Entity('sp_roster')
export class SpRosterPerson {
  @PrimaryColumn()
  id: string;

  @Column()
  name: string;

  /** As written: "Writer", "Editor", "Content Team". */
  @Column({ default: '' })
  position: string;

  /** 'writer' | 'editor' | 'other' */
  @Column({ default: 'other' })
  roleGroup: string;

  /** Daily bandwidth ("BW"), where the sheet gives a number. */
  @Column({ type: 'real', nullable: true })
  dailyTarget: number | null;

  /** BW as written, e.g. "10 + MSN". */
  @Column({ default: '' })
  bandwidthNote: string;

  @Column({ default: '' })
  timings: string;

  @Column({ default: '' })
  shift: string;

  @Column({ default: '' })
  weekoff: string;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @Column({ type: 'text', default: '' })
  rawHash: string;
}
