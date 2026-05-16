import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('msn_allotment_rows')
export class MsnAllotmentRow {
  @PrimaryColumn()
  id: string;

  @Index()
  @Column()
  allottedBy: string;

  @Index()
  @Column({ type: 'date', nullable: true })
  date: string | null;

  @Column({ default: 'NFL' })
  brand: string;

  @Index()
  @Column()
  feed: string;

  @Index()
  @Column()
  writer: string;

  @Index()
  @Column()
  contentType: string;

  @Index()
  @Column()
  status: string;

  @Column({ type: 'int', nullable: true })
  slides: number | null;

  @Column({ type: 'text', default: '' })
  title: string;

  @Column({ type: 'text', default: '' })
  rawHash: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
