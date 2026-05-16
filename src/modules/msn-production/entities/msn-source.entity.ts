import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('msn_source_rows')
export class MsnSourceRow {
  @PrimaryColumn()
  rowId: string;

  @Index()
  @Column({ type: 'date', nullable: true })
  date: string | null;

  @Column({ default: 'NFL' })
  brand: string;

  @Index()
  @Column()
  contentType: string;

  @Index()
  @Column()
  feed: string;

  @Index()
  @Column()
  writer: string;

  @Index()
  @Column()
  editor: string;

  @Index()
  @Column()
  status: string;

  @Column({ type: 'int', nullable: true })
  numberOfSlides: number | null;

  @Column({ type: 'timestamp', nullable: true })
  publishTimestamp: Date | null;

  @Column({ type: 'text', default: '' })
  title: string;

  @Column({ type: 'text', default: '' })
  rawHash: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
