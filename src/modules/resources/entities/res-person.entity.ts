import { Entity, Column, PrimaryColumn, Index } from 'typeorm';

/**
 * One person from the aggregate sheet's People tab, which the n8n resources
 * lane builds from the "Team Structure" tab of the managers' Operational
 * Dashboard workbook. The one people list for Critical Flow and Yahoo alike.
 *
 * The cf_ table name and some column names predate Team Structure; they are
 * kept so existing deployments need no migration.
 */
@Entity('cf_schedule_person')
export class ResPerson {
  /** hash(primaryDivision | name) */
  @PrimaryColumn()
  id: string;

  @Index()
  @Column()
  name: string;

  /**
   * Canonical division; "Associate" / "Newsroom" for the floating editor pools.
   * A vertical with no Critical Flow or Yahoo content ("NetflixJunkie", "ES
   * Daily") is kept as written and flagged off-desk.
   */
  @Index()
  @Column({ default: 'Unknown' })
  primaryDivision: string;

  /** Sub-feed when the division is split ("Tennis", "Olympics"), else ''. */
  @Column({ default: '' })
  subFeed: string;

  /** Other verticals the sheet lists them under ("College Football NCAA / Tennis"). */
  @Column({ type: 'simple-array', default: '' })
  secondaryDivisions: string[];

  /** Role / Designation as written — "Writer", "Producer", "NL Editor", "Sub-Group Head". */
  @Column({ default: '' })
  role: string;

  /** writer | editor | lead | other */
  @Index()
  @Column({ default: 'other' })
  roleGroup: string;

  /** Pod | Non-pod | Stables | Associate | Newsroom | '' */
  @Column({ default: '' })
  pod: string;

  /** EMP | LNP | REG | '' */
  @Column({ default: '' })
  shift: string;

  /** Hours as written, e.g. "6 PM - 3 AM"; a bare start time as "8 AM". */
  @Column({ default: '' })
  shiftClock: string;

  /** Full day names, e.g. "Thursday"; comma-separated when there are several. */
  @Column({ default: '' })
  weekoff: string;

  /**
   * Per-weekday rota, JSON: { Monday: { off: true, coverBy: "Aadesh" }, … }.
   * Team Structure has no rota, so this is '{}' until a source provides one.
   */
  @Column({ type: 'text', default: '{}' })
  weekPlan: string;

  /** Named backups in the sheet's order (1st, 2nd, …), comma-separated. */
  @Column({ default: '' })
  backup: string;

  /** Full-time | Part-time | '' from the FT/PT column. Exited / Inactive also count as off. */
  @Column({ default: '' })
  status: string;

  /** Team Structure's Division column: "Critical Flow", "Newsletter", or ''. */
  @Column({ name: 'sources', default: '' })
  team: string;

  /** Data-quality notes from the lane, e.g. "duplicate-row", "off-desk", "week-off-unclear". */
  @Column({ default: '' })
  flags: string;

  @Column({ default: '' })
  rawHash: string;
}
