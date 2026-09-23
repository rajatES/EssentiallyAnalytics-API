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
  MANAGEMENT = 'management',
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
