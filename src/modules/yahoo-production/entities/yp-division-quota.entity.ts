import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Daily piece quota per division, from the source workbook's "Roster" tab.
 *
 * "Tennis+Olympics" is one quota row while the content records Tennis and
 * Olympics as separate divisions, so a quota can cover more than one division;
 * `divisions` holds the expanded list and is what attainment is measured
 * against.
 */
@Entity('yp_division_quotas')
export class YpDivisionQuota {
  @PrimaryColumn()
  id: string;

  /** The label as the sheet writes it, e.g. "Tennis+Olympics". */
  @Column({ default: '' })
  division: string;

  /** Expanded content divisions this quota covers. */
  @Column({ type: 'simple-array', default: '' })
  divisions: string[];

  @Column({ type: 'int', nullable: true })
  quota: number | null;

  /** Delivery window as written, e.g. "6 AM - 10 PM". */
  @Column({ default: '' })
  window: string;

  /** Point of contact. */
  @Column({ default: '' })
  poc: string;

  @Column({ type: 'text', default: '' })
  rawHash: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
