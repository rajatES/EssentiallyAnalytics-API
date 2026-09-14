import { Entity, Column, PrimaryColumn, Index } from 'typeorm';

/**
 * One person as the desk managers describe them in the "Dynamic Schedule"
 * workbook — merged from its Writer Info, Editor Info and Roles & Contact
 * tabs. This is the managers' own canonical list, and it names people (and
 * divisions) the per-division source sheets never do.
 */
@Entity('cf_schedule_person')
export class CfSchedulePerson {
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
