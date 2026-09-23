import { Entity, Column, PrimaryColumn, Index } from 'typeorm';

/**
 * One person from the aggregate sheet's People tab, which the n8n resources
 * lane builds from the managers' "Dynamic Schedule" workbook (Writer Info,
 * Editor Info and Roles & Contact merged). The one people list for Critical
 * Flow and Yahoo alike.
 *
 * The cf_ table name predates Yahoo sharing it; it is kept so existing
 * deployments need no migration.
 */
@Entity('cf_schedule_person')
export class ResPerson {
  /** hash(primaryDivision | name) */
  @PrimaryColumn()
  id: string;

  @Index()
  @Column()
  name: string;

  /** Canonical division; "Associate" for the floating editor pool. */
  @Index()
  @Column({ default: 'Unknown' })
  primaryDivision: string;

  /** Sub-feed when the division is split ("Tennis", "Olympics"), else ''. */
  @Column({ default: '' })
  subFeed: string;

  /** Other divisions the sheet lists them under (Editor Info "NFL/CFB"). */
  @Column({ type: 'simple-array', default: '' })
  secondaryDivisions: string[];

  /** Free text from the sheet — "Writer", "Producer (Editor)", "Associate Editor". */
  @Column({ default: '' })
  role: string;

  /** writer | editor | lead | other */
  @Index()
  @Column({ default: 'other' })
  roleGroup: string;

  /** Pod | Non-pod | Associate | '' */
  @Column({ default: '' })
  pod: string;

  /** EMP | LNP | REG | '' */
  @Column({ default: '' })
  shift: string;

  /** Clock hours as written, e.g. "6 PM - 3 AM". */
  @Column({ default: '' })
  shiftClock: string;

  @Column({ default: '' })
  weekoff: string;

  /**
   * Per-weekday status from Editor Info, JSON: { Mon: { off: true, coverBy: "Aadesh" }, … }.
   * Empty object for people that tab does not list.
   */
  @Column({ type: 'text', default: '{}' })
  weekPlan: string;

  /** Standing backup named in Editor Info. */
  @Column({ default: '' })
  backup: string;

  /** Active | Inactive | '' from Roles & Contact. */
  @Column({ default: '' })
  status: string;

  /** Which tabs contributed, e.g. "Writer Info,Editor Info". */
  @Column({ default: '' })
  sources: string;

  /** Data-quality notes raised while merging tabs, e.g. "role-conflict". */
  @Column({ default: '' })
  flags: string;

  @Column({ default: '' })
  rawHash: string;
}
