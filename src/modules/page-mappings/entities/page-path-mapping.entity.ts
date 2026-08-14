import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

/**
 * Maps a landing-page URL pattern to a page name / category / team.
 *
 * The sibling of `page_mappings`, for traffic that carries no usable UTM. A
 * `page_mappings` row answers "which of our social accounts sent this?"; a row
 * here answers "which of our content does this traffic belong to?". Both exist
 * because organic referral traffic (most of Reddit since July 2026) has no
 * medium to key off, only a landing page.
 *
 * Deliberately not platform-scoped: the same article takes traffic from every
 * platform, so one pattern applies across all tabs.
 */
@Entity('page_path_mappings')
export class PagePathMapping {
  @PrimaryGeneratedColumn()
  id: number;

  /** Glob against the landing path, e.g. '/wnba-*'. Only '*' is special. */
  @Index({ unique: true })
  @Column({ type: 'text', unique: true })
  pattern: string;

  @Column()
  pageName: string;

  @Column({ default: 'Uncategorized' })
  category: string;

  @Column({ type: 'varchar', nullable: true })
  team: string | null;

  /** Higher wins when several patterns match; ties break on specificity. */
  @Column({ type: 'int', default: 0 })
  priority: number;
}
