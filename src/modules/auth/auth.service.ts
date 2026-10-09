import {
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { User, UserRole } from './entities/user.entity';
import { OtpService } from './otp.service';
import { MailService } from '../../common/mail/mail.service';
import { CodePurpose, otpEmail } from './otp-email';
import { ASSIGNABLE_ROLES } from './roles';

const BCRYPT_ROUNDS = 10;
/** bcrypt reads only the first 72 bytes; anything longer would be silently truncated. */
const MAX_PASSWORD_BYTES = 72;
const MIN_PASSWORD_LENGTH = 8;

export interface Session {
  apiKey: string;
  email: string;
  role: UserRole;
}

export interface UserSummary {
  id: string;
  email: string;
  role: UserRole;
  createdAt: string;
  lastLoginAt: string | null;
  passwordUpdatedAt: string | null;
}

function newApiKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private userRepo: Repository<User>,
    private readonly otp: OtpService,
    private readonly mail: MailService,
  ) {}

  async onModuleInit() {
    await this.bootstrapSuperadmin().catch((e) =>
      this.logger.error(`Superadmin bootstrap failed: ${e.message}`),
    );
  }

  // ── Identity ──

  /** Only addresses on this domain may sign up or reset through the code flow. */
  private allowedDomain(): string {
    return (process.env.ACCESS_EMAIL_DOMAIN || 'essentiallysports.com').toLowerCase();
  }

  private superadminEmail(): string {
    return normalizeEmail(process.env.SUPERADMIN_EMAIL || '');
  }

  /**
   * Accounts created before sign-up existed were stored with whatever case the
   * setup call used, so lookups ignore case.
   */
  private findByEmail(email: string): Promise<User | null> {
    return this.userRepo
      .createQueryBuilder('u')
      .where('LOWER(u.email) = :email', { email: normalizeEmail(email) })
      .getOne();
  }

  private assertOnDomain(email: string) {
    const domain = this.allowedDomain();
    const re = new RegExp(`^[a-z0-9._%+-]+@${domain.replace(/[.]/g, '\\.')}$`);
    if (!re.test(email)) {
      throw new BadRequestException(`Use your @${domain} email address.`);
    }
  }

  private assertPassword(password: string) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestException(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
      throw new BadRequestException(`Password must be at most ${MAX_PASSWORD_BYTES} characters.`);
    }
  }

  // ── Password login ──

  async login(email: string, pass: string) {
    const user = await this.findByEmail(email);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isMatch = await bcrypt.compare(pass, user.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.apiKey) user.apiKey = newApiKey();
    user.lastLoginAt = new Date();
    await this.userRepo.save(user);

    return {
      message: 'Login successful',
      apiKey: user.apiKey,
      email: user.email,
      role: user.role,
    };
  }

  async getMe(apiKey: string) {
    const user = await this.userRepo.findOne({ where: { apiKey } });
    if (!user) throw new UnauthorizedException();
    return { email: user.email, role: user.role };
  }

  // ── Sign-up and password reset by emailed code ──

  /**
   * Step 1: email a code. The answer is the same whether or not the address
   * already has an account, so the endpoint cannot be used to list who does.
   */
  async requestCode(rawEmail: string, ip: string, purpose: CodePurpose): Promise<{ message: string }> {
    const email = normalizeEmail(rawEmail);
    this.assertOnDomain(email);
    const generic = {
      message: `If ${email} can use EssentiallyAnalytics, a 6-digit code is on its way. It expires in 10 minutes.`,
    };

    // The superadmin's password lives in the server config; a code must not
    // be able to replace it.
    if (email === this.superadminEmail()) {
      this.logger.warn('Refused a sign-in code for the superadmin address');
      return generic;
    }

    if (!this.otp.isConfigured()) {
      throw new ServiceUnavailableException('Sign-up is not configured on the server (OTP_SIGNING_SECRET unset).');
    }
    // Local development usually has no SMTP. AUTH_DEV_LOG_CODES=true prints the
    // code to the server log instead — an explicit opt-in, and refused in
    // production, where a logged code is a leaked code.
    const logCodes =
      process.env.AUTH_DEV_LOG_CODES === 'true' && process.env.NODE_ENV !== 'production';
    if (!this.mail.isConfigured() && !logCodes) {
      throw new ServiceUnavailableException('Email is not configured on the server (SMTP unset).');
    }

    const outcome = await this.otp.request(email, ip);
    if (!outcome.ok) {
      // Said plainly rather than dropped silently: a request that looks lost
      // makes people retry, which is exactly what the limit is there to stop.
      throw new HttpException(
        'Too many code requests. Wait a few minutes and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (!this.mail.isConfigured()) {
      this.logger.warn(`[AUTH_DEV_LOG_CODES] ${purpose} code for ${email}: ${outcome.code}`);
      return generic;
    }

    const mail = otpEmail(outcome.code, outcome.expiresInMinutes, purpose);
    try {
      await this.mail.send({ to: email, subject: mail.subject, text: mail.text, html: mail.html });
    } catch (e: any) {
      // The reason stays in the server log; the code never appears anywhere but the email.
      this.logger.error(`Could not send a sign-in code: ${e.message}`);
      throw new ServiceUnavailableException('Could not send the email right now. Try again shortly.');
    }
    return generic;
  }

  /** Step 2: trade a correct code for a short-lived setup token. */
  async verifyCode(rawEmail: string, code: string): Promise<{ setupToken: string; hasAccount: boolean }> {
    const email = normalizeEmail(rawEmail);
    this.assertOnDomain(email);
    if (!/^\d{6}$/.test(String(code || '').trim())) {
      throw new BadRequestException('That code is invalid or has expired. Request a new one.');
    }

    const outcome = await this.otp.verify(email, String(code).trim());
    if (!outcome.ok) {
      if (outcome.reason === 'too_many_attempts') {
        throw new HttpException('Too many incorrect attempts. Request a new code.', HttpStatus.TOO_MANY_REQUESTS);
      }
      throw new BadRequestException('That code is invalid or has expired. Request a new one.');
    }
    return { setupToken: outcome.setupToken, hasAccount: !!(await this.findByEmail(email)) };
  }

  /**
   * Step 3: set the password — creating the account if it is new, with no
   * section until the superadmin gives it one, or resetting it if not — and
   * sign in. A reset rotates the session key, which signs the account out
   * everywhere else.
   */
  async setPassword(
    rawEmail: string,
    setupToken: string,
    password: string,
  ): Promise<Session & { created: boolean }> {
    const email = normalizeEmail(rawEmail);
    this.assertOnDomain(email);
    this.assertPassword(password);
    if (email === this.superadminEmail()) {
      throw new ForbiddenException('This account is managed in the server configuration.');
    }

    if (!(await this.otp.consumeSetupToken(email, String(setupToken || '')))) {
      throw new BadRequestException('This verification has expired. Start again to get a new code.');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const now = new Date();
    let user = await this.findByEmail(email);
    const created = !user;
    if (!user) {
      user = this.userRepo.create({ email, role: UserRole.USER });
    }
    user.passwordHash = passwordHash;
    user.apiKey = newApiKey();
    user.passwordUpdatedAt = now;
    user.lastLoginAt = now;
    await this.userRepo.save(user);
    this.logger.log(`${created ? 'Account created' : 'Password reset'} for ${email}`);

    return { apiKey: user.apiKey, email: user.email, role: user.role, created };
  }

  // ── Superadmin ──

  /**
   * The superadmin is defined by SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD and
   * re-applied on every boot: changing the password in the env rotates it (and
   * signs the old sessions out), and pointing the env at a new address demotes
   * the previous superadmin, so there is only ever one.
   */
  private async bootstrapSuperadmin(): Promise<void> {
    const email = this.superadminEmail();
    const password = process.env.SUPERADMIN_PASSWORD || '';
    if (!email || !password) {
      this.logger.warn('SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD not set — nobody can change access levels');
      return;
    }
    if (password.length < 12 || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
      this.logger.error('SUPERADMIN_PASSWORD must be 12–72 characters; superadmin not configured');
      return;
    }

    let user = await this.findByEmail(email);
    if (!user) {
      user = this.userRepo.create({
        email,
        role: UserRole.SUPERADMIN,
        passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        apiKey: newApiKey(),
        passwordUpdatedAt: new Date(),
      });
      await this.userRepo.save(user);
      this.logger.log(`Superadmin created: ${email}`);
    } else {
      let changed = false;
      if (user.role !== UserRole.SUPERADMIN) {
        user.role = UserRole.SUPERADMIN;
        changed = true;
      }
      if (!(await bcrypt.compare(password, user.passwordHash))) {
        user.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        user.apiKey = newApiKey();
        user.passwordUpdatedAt = new Date();
        changed = true;
      }
      if (changed) {
        await this.userRepo.save(user);
        this.logger.log(`Superadmin updated from the environment: ${email}`);
      }
    }

    const others = await this.userRepo.find({
      where: { role: UserRole.SUPERADMIN, id: Not(user.id) },
    });
    for (const o of others) {
      o.role = UserRole.USER;
      o.apiKey = newApiKey();
      await this.userRepo.save(o);
      this.logger.warn(`Former superadmin ${o.email} demoted to user and signed out`);
    }
  }

  async listUsers(): Promise<UserSummary[]> {
    const users = await this.userRepo.find({ order: { createdAt: 'ASC' } });
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      createdAt: u.createdAt.toISOString(),
      lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
      passwordUpdatedAt: u.passwordUpdatedAt ? u.passwordUpdatedAt.toISOString() : null,
    }));
  }

  /** Takes effect on the user's next request — the guard reads the role fresh each time. */
  async setRole(id: string, role: UserRole): Promise<UserSummary> {
    if (!ASSIGNABLE_ROLES.includes(role)) {
      throw new BadRequestException(`Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}`);
    }
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('No such user');
    if (user.role === UserRole.SUPERADMIN) {
      throw new ForbiddenException('The superadmin is managed in the server configuration.');
    }
    if (user.role !== role) {
      this.logger.log(`Role for ${user.email}: ${user.role} → ${role}`);
      user.role = role;
      await this.userRepo.save(user);
    }
    return (await this.listUsers()).find((u) => u.id === id)!;
  }

  // ── Legacy provisioning (SETUP_SECRET) ──

  async createUser(
    email: string,
    plainTextPassword: string,
    role: UserRole = UserRole.USER,
  ) {
    if (!email || !plainTextPassword) {
      throw new BadRequestException('Email and password are required');
    }
    if (role === UserRole.SUPERADMIN) {
      throw new BadRequestException('The superadmin is defined by SUPERADMIN_EMAIL, not created here');
    }
    const existingUser = await this.findByEmail(email);
    if (existingUser) {
      throw new ConflictException('A user with this email already exists');
    }
    const passwordHash = await bcrypt.hash(plainTextPassword, BCRYPT_ROUNDS);
    const newUser = this.userRepo.create({
      email,
      passwordHash,
      apiKey: newApiKey(),
      role,
    });

    await this.userRepo.save(newUser);

    return {
      message: 'Account created successfully.',
      email: newUser.email,
      role: newUser.role,
    };
  }
}
