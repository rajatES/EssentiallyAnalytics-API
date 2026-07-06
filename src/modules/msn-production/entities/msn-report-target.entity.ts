import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Editable per-publication daily targets for the syndication reports.
 * Seeded from the static defaults (reports-config.ts) on first boot, then
 * owned by the DB so the dashboard's "Targets" editor can change them without
 * a redeploy. Keyed on the full publication name.
 */
@Entity('msn_report_target')
export class MsnReportTarget {
  @PrimaryColumn()
  publication: string;

  @Column({ default: '' })
  shortName: string;

  @Column({ default: '' })
  tier: string;

  @Column({ type: 'int', default: 0 })
  articleTarget: number;

  @Column({ type: 'int', default: 0 })
  slideshowTarget: number;

  @Column({ type: 'int', default: 0 })
  videoTarget: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
