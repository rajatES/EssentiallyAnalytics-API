import { Entity, Column, PrimaryColumn } from 'typeorm';

/**
 * One roster assignment row from the integrated sheet's Roster tab.
 * A person can appear in several rows (one per division/feed/role combo).
 */
@Entity('msn_roster')
export class MsnRosterPerson {
  @PrimaryColumn()
  id: string;

  @Column({ default: 'Unknown' })
  division: string;

  @Column({ default: 'Unknown' })
  feed: string;

  @Column()
  name: string;

  @Column({ default: '' })
  role: string;

  @Column({ default: '' })
  weekoff: string;

  @Column()
  rawHash: string;
}
