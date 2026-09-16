import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('page_mappings')
export class PageMapping {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  category: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  team: string | null;

  @Column()
  platform: string;

  @Column()
  pageName: string;

  @Column()
  utmSource: string;

  @Column('text', { array: true })
  utmMediums: string[];

  /**
   * Manually entered click-through URL, overriding whatever the page directory
   * resolves by name. Traffic rows carry no platform identifier of their own,
   * so this is the only way to link a page Meta never told us about — every
   * Threads account, and any page whose traffic name differs from its Meta
   * name.
   */
  @Column({ type: 'text', nullable: true })
  pageUrl: string | null;
}
