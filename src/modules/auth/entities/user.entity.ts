import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';

export enum UserRole {
  /**
   * The one account that hands out access. Defined by SUPERADMIN_EMAIL /
   * SUPERADMIN_PASSWORD and seeded on boot; never assignable through the API.
   */
  SUPERADMIN = 'superadmin',
  ADMIN = 'admin',
  SM_MANAGER = 'sm_manager',
  SM_USER = 'sm_user',
  CF_MANAGER = 'cf_manager',
  CF_USER = 'cf_user',
  /**
   * A manager with no section, left over from before sections existed. Not
   * assignable any more; as a `@MinRole` it still means "any manager".
   */
  MANAGEMENT = 'management',
  /**
   * No section yet — where every sign-up starts, and it opens no pages until
   * the superadmin picks one. As a `@MinRole` it means "anyone signed in".
   */
  USER = 'user',
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column()
  passwordHash: string;

  @Column({ unique: true, nullable: true })
  apiKey: string;

  @Column({ type: 'varchar', default: UserRole.USER })
  role: UserRole;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  passwordUpdatedAt: Date | null;
}
