import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, MoreThan, Repository } from 'typeorm';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { AuthOtp } from './entities/auth-otp.entity';

// Ported from es-mcp's utilities/otp.ts; the reasoning there holds here too.
// A 6-digit code is only 1e6 wide, so what keeps it from being brute-forced is
// the attempt cap per code plus the request limits per address and per IP.
const CODE_LENGTH = 6;
const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS_PER_CODE = 5;
const MAX_REQUESTS_PER_EMAIL = 3;
const EMAIL_WINDOW_MINUTES = 15;
const MAX_REQUESTS_PER_IP = 10;
const IP_WINDOW_MINUTES = 60;
/** How long a verified code's setup token stays usable for choosing a password. */
const SETUP_TTL_MINUTES = 15;

export type RequestOutcome =
  | { ok: true; code: string; expiresInMinutes: number }
  | { ok: false; reason: 'rate_limited_email' | 'rate_limited_ip' };

export type VerifyOutcome =
  | { ok: true; setupToken: string }
  | { ok: false; reason: 'no_code' | 'expired' | 'too_many_attempts' | 'mismatch' };

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60_000);
}

function minutesFromNow(n: number): Date {
  return new Date(Date.now() + n * 60_000);
}

/**
 * Email one-time codes for sign-up and password reset.
 *
 * Everything here fails closed: a database error propagates and is a refusal,
 * never a grant.
 */
@Injectable()
export class OtpService {
  constructor(@InjectRepository(AuthOtp) private readonly repo: Repository<AuthOtp>) {}

  isConfigured(): boolean {
    return !!process.env.OTP_SIGNING_SECRET;
  }

  private secret(): string {
    const s = process.env.OTP_SIGNING_SECRET;
    if (!s) throw new Error('OTP_SIGNING_SECRET is not set');
    return s;
  }

  /** The email is bound in, so a code minted for one address cannot be replayed against another. */
  private hash(email: string, value: string): string {
    return createHmac('sha256', this.secret()).update(`${email} ${value}`).digest('hex');
  }

  /**
   * Mints a code for `email` and returns it to the caller to email. It must
   * never reach a response body, a log line or an error message.
   */
  async request(email: string, ip: string): Promise<RequestOutcome> {
    const byEmail = await this.repo.count({
      where: { email, createdAt: MoreThan(minutesAgo(EMAIL_WINDOW_MINUTES)) },
    });
    if (byEmail >= MAX_REQUESTS_PER_EMAIL) return { ok: false, reason: 'rate_limited_email' };

    if (ip) {
      const byIp = await this.repo.count({
        where: { ip, createdAt: MoreThan(minutesAgo(IP_WINDOW_MINUTES)) },
      });
      if (byIp >= MAX_REQUESTS_PER_IP) return { ok: false, reason: 'rate_limited_ip' };
    }

    // One live code per address, so spamming requests cannot build a pool of valid codes.
    await this.repo.update(
      { email, consumedAt: IsNull(), invalidatedAt: IsNull() },
      { invalidatedAt: new Date() },
    );

    const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
    await this.repo.insert({
      email,
      codeHash: this.hash(email, code),
      ip: ip || null,
      attempts: 0,
      expiresAt: minutesFromNow(CODE_TTL_MINUTES),
    });
    return { ok: true, code, expiresInMinutes: CODE_TTL_MINUTES };
  }

  /**
   * Checks a code against the newest live one for the address. Single use: on
   * success the code is consumed and exchanged for a setup token, which is what
   * the password step then presents.
   */
  async verify(email: string, code: string): Promise<VerifyOutcome> {
    const row = await this.repo.findOne({
      where: { email, consumedAt: IsNull(), invalidatedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
    if (!row) return { ok: false, reason: 'no_code' };

    if (row.expiresAt.getTime() <= Date.now()) {
      await this.repo.update(row.id, { invalidatedAt: new Date() });
      return { ok: false, reason: 'expired' };
    }
    // Counted before comparing, so a crash mid-verify cannot buy a free guess —
    // and counted in one conditional UPDATE, so a burst of parallel guesses
    // cannot all read "4 attempts" and slip past the cap together.
    const bumped = await this.repo
      .createQueryBuilder()
      .update()
      .set({ attempts: () => 'attempts + 1' })
      .where('id = :id AND attempts < :max', { id: row.id, max: MAX_ATTEMPTS_PER_CODE })
      .returning(['attempts'])
      .execute();
    if (!bumped.affected) {
      await this.repo.update(row.id, { invalidatedAt: new Date() });
      return { ok: false, reason: 'too_many_attempts' };
    }
    const attempts = Number(bumped.raw?.[0]?.attempts ?? MAX_ATTEMPTS_PER_CODE);

    const expected = Buffer.from(row.codeHash, 'utf8');
    const actual = Buffer.from(this.hash(email, code), 'utf8');
    const match = expected.length === actual.length && timingSafeEqual(expected, actual);

    if (!match) {
      if (attempts >= MAX_ATTEMPTS_PER_CODE) {
        await this.repo.update(row.id, { invalidatedAt: new Date() });
      }
      return { ok: false, reason: 'mismatch' };
    }

    const setupToken = randomBytes(32).toString('hex');
    const consumed = await this.repo.update(
      { id: row.id, consumedAt: IsNull(), invalidatedAt: IsNull() },
      {
        consumedAt: new Date(),
        setupTokenHash: this.hash(email, setupToken),
        setupExpiresAt: minutesFromNow(SETUP_TTL_MINUTES),
      },
    );
    // Two correct submissions racing: only the one that consumed the row wins.
    if ((consumed.affected ?? 0) !== 1) return { ok: false, reason: 'no_code' };
    return { ok: true, setupToken };
  }

  /** Spends a setup token. True only once, and only within its lifetime. */
  async consumeSetupToken(email: string, setupToken: string): Promise<boolean> {
    const result = await this.repo.update(
      {
        email,
        setupTokenHash: this.hash(email, setupToken),
        setupUsedAt: IsNull(),
        setupExpiresAt: MoreThan(new Date()),
      },
      { setupUsedAt: new Date() },
    );
    // A conditional UPDATE, so two racing requests cannot both spend one token.
    return (result.affected ?? 0) === 1;
  }

  @Cron('0 3 * * *')
  async prune(): Promise<void> {
    await this.repo.delete({ createdAt: LessThan(minutesAgo(7 * 24 * 60)) });
  }
}
