import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * One emailed sign-up / password-reset code, and the setup token it is
 * exchanged for once verified.
 *
 * Neither the code nor the token is stored in plaintext — only an HMAC of each —
 * so a database dump hands an attacker nothing live.
 */
@Entity('auth_otp')
@Index(['email', 'createdAt'])
@Index(['ip', 'createdAt'])
export class AuthOtp {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column()
  email: string;

  @Column()
  codeHash: string;

  @Column({ type: 'varchar', nullable: true })
  ip: string | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  /** Set when the code is verified; a code verifies once. */
  @Column({ type: 'timestamptz', nullable: true })
  consumedAt: Date | null;

  /** Set when a newer code, an expiry or the attempt cap retires this one. */
  @Column({ type: 'timestamptz', nullable: true })
  invalidatedAt: Date | null;

  @Index()
  @Column({ type: 'varchar', nullable: true })
  setupTokenHash: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  setupExpiresAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  setupUsedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
