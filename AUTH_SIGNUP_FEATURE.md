# Auth: Signup + Email-OTP Verification + Forgot Password (parked)

This feature was implemented and then **reverted** (login was restored to its original
state). This document is a complete reimplementation kit — dropping these files/edits
back in restores the full self-service signup + OTP verification + forgot-password flow.

## Requirements

1. **Signup** open only to `@essentiallysports.com` emails.
2. Signup verifies the email via a **6-digit OTP** emailed to the address before the
   account becomes usable.
3. After verification, the user logs in with email + password.
4. **Forgot-password** flow (OTP-based) to reset the password.
5. Self-service signups get **`management`** (manager-level) access. **`admin`** accounts
   are created only by the owner via the existing curl/`setup` endpoint.

## Design decisions (agreed)

- Password reset uses an **email OTP code** (not a reset link), reusing the signup OTP plumbing.
- The curl `setup` (admin creation) endpoint stays **unrestricted** by domain; only public
  signup is domain-locked.
- After OTP verification the user is **redirected to `/login`** (verification activates the
  account; no auto-login).

## How it builds on what exists

- `User.apiKey` doubles as the session token stored in the `auth_token` cookie.
- Global `ApiKeyGuard` + `@Public()` decorator gate every route.
- Frontend `useRole` already understands `admin/management/user`.
- Nodemailer/SMTP was already used by the `email-reports` module; the mail service below
  mirrors its transporter setup.

## Environment / ops notes

- OTP delivery needs SMTP env vars on the API: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
  `SMTP_PASS`, `SMTP_FROM`. Without SMTP the code logs the OTP instead of sending (dev-safe).
- New `User` columns require the schema to update: `DB_SYNC=true` (already set in
  docker-compose) or a manual `ALTER TABLE users ...`.
- Admin creation is unchanged — the existing curl call still works:
  ```bash
  curl -X POST <api>/api/auth/setup \
    -H "x-setup-secret: $SETUP_SECRET" \
    -H "Content-Type: application/json" \
    -d '{"email":"you@essentiallysports.com","password":"...","role":"admin"}'
  ```

---

# Backend (`ES_Studio_API`)

## 1. `src/modules/auth/entities/user.entity.ts` — add OTP fields

Add to the `User` entity (and export the `OtpPurpose` type):

```ts
export type OtpPurpose = 'signup' | 'reset';

// ...inside class User, after `role`:
  @Column({ default: false })
  isVerified: boolean;

  @Column({ type: 'varchar', nullable: true })
  otpHash: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  otpExpiresAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  otpPurpose: OtpPurpose | null;

  // Locks the current OTP after too many wrong guesses.
  @Column({ type: 'int', default: 0 })
  otpAttempts: number;
```

## 2. `src/common/mail/mail.service.ts` (new)

```ts
import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { OtpPurpose } from '../../modules/auth/entities/user.entity';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;

  constructor() {
    this.initTransporter();
  }

  private initTransporter() {
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (!host || !user || !pass) {
      this.logger.warn(
        'SMTP not configured — OTP emails will be disabled. Set SMTP_HOST, SMTP_USER, SMTP_PASS.',
      );
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });

    this.logger.log(`SMTP transporter initialized: ${host}:${port}`);
  }

  async sendOtp(to: string, code: string, purpose: OtpPurpose): Promise<void> {
    if (!this.transporter) {
      this.logger.warn(
        `SMTP not configured — OTP for ${to} (${purpose}) is ${code}`,
      );
      return;
    }

    const isReset = purpose === 'reset';
    const title = isReset ? 'Reset your password' : 'Verify your email';
    const intro = isReset
      ? 'Use the code below to reset your ES Studio password. It expires in 10 minutes.'
      : 'Welcome to ES Studio! Use the code below to verify your email. It expires in 10 minutes.';

    const fromAddr =
      process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@studio.local';

    await this.transporter.sendMail({
      from: fromAddr,
      to,
      subject: `${code} is your ES Studio verification code`,
      html: this.buildOtpHtml(title, intro, code),
    });

    this.logger.log(`OTP (${purpose}) sent to ${to}`);
  }

  private buildOtpHtml(title: string, intro: string, code: string): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8f9fa; margin: 0; padding: 0; }
    .container { max-width: 480px; margin: 0 auto; padding: 32px 16px; }
    .card { background: #fff; border-radius: 12px; padding: 32px; border: 1px solid #e5e7eb; text-align: center; }
    h1 { font-size: 20px; color: #111827; margin: 0 0 8px 0; }
    .intro { font-size: 13px; color: #6b7280; margin: 0 0 24px 0; line-height: 1.5; }
    .code { font-size: 34px; font-weight: 700; letter-spacing: 8px; color: #2563eb; background: #eff6ff; border-radius: 10px; padding: 16px; margin: 0 0 24px; }
    .note { font-size: 12px; color: #9ca3af; margin: 0; }
    .footer { text-align: center; padding: 20px 0 0; font-size: 11px; color: #9ca3af; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>${title}</h1>
      <p class="intro">${intro}</p>
      <div class="code">${code}</div>
      <p class="note">If you didn't request this, you can safely ignore this email.</p>
    </div>
    <div class="footer">ES Studio Analytics</div>
  </div>
</body>
</html>`;
  }
}
```

## 3. `src/common/mail/mail.module.ts` (new)

```ts
import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
```

## 4. DTOs (new, under `src/common/dto/`)

`signup.dto.ts`
```ts
import { IsEmail, IsString, MinLength } from 'class-validator';

export class SignupDto {
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  password: string;
}
```

`verify-otp.dto.ts`
```ts
import { IsEmail, IsString, Length, Matches } from 'class-validator';

export class VerifyOtpDto {
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;

  @IsString()
  @Length(6, 6, { message: 'The code must be 6 digits' })
  @Matches(/^\d{6}$/, { message: 'The code must be 6 digits' })
  otp: string;
}
```

`resend-otp.dto.ts`
```ts
import { IsEmail } from 'class-validator';

export class ResendOtpDto {
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;
}
```

`forgot-password.dto.ts`
```ts
import { IsEmail } from 'class-validator';

export class ForgotPasswordDto {
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;
}
```

`reset-password.dto.ts`
```ts
import { IsEmail, IsString, Length, Matches, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;

  @IsString()
  @Length(6, 6, { message: 'The code must be 6 digits' })
  @Matches(/^\d{6}$/, { message: 'The code must be 6 digits' })
  otp: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  newPassword: string;
}
```

## 5. `src/modules/auth/auth.service.ts` — add the flow

Inject `MailService`, add the constants and methods below, and modify `login()` (block
unverified users) and `createUser()` (mark admins verified):

```ts
import { MailService } from '../../common/mail/mail.service';
import { User, UserRole, OtpPurpose } from './entities/user.entity';

const ESSENTIALLY_DOMAIN = '@essentiallysports.com';
const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const GENERIC_OTP_MESSAGE =
  'If an account matching that email exists, a verification code has been sent.';

// constructor: add `private readonly mailService: MailService,`

// In login(), after the password check succeeds:
//   if (!user.isVerified) throw new UnauthorizedException('Please verify your email before logging in');

// In createUser(), set `isVerified: true` on the created user.

async signup(email: string, plainTextPassword: string) {
  const normalized = this.normalizeEmail(email);
  if (!normalized.endsWith(ESSENTIALLY_DOMAIN)) {
    throw new BadRequestException(
      `Signup is restricted to ${ESSENTIALLY_DOMAIN} email addresses`,
    );
  }
  const passwordHash = await bcrypt.hash(plainTextPassword, 10);
  const existing = await this.userRepo.findOne({ where: { email: normalized } });
  if (existing?.isVerified) {
    throw new ConflictException('An account with this email already exists');
  }
  const user =
    existing ??
    this.userRepo.create({
      email: normalized,
      role: UserRole.MANAGEMENT,
      isVerified: false,
    });
  user.passwordHash = passwordHash;
  await this.issueOtp(user, 'signup');
  return { message: 'Verification code sent. Please check your email.', email: normalized };
}

async verifyOtp(email: string, otp: string, expectedPurpose: OtpPurpose) {
  const user = await this.consumeOtp(email, otp, expectedPurpose);
  if (expectedPurpose === 'signup') user.isVerified = true;
  this.clearOtp(user);
  await this.userRepo.save(user);
  return { message: 'Email verified successfully. You can now log in.' };
}

async resendOtp(email: string) {
  const user = await this.userRepo.findOne({ where: { email: this.normalizeEmail(email) } });
  if (user && !user.isVerified) await this.issueOtp(user, 'signup');
  return { message: GENERIC_OTP_MESSAGE };
}

async forgotPassword(email: string) {
  const user = await this.userRepo.findOne({ where: { email: this.normalizeEmail(email) } });
  if (user && user.isVerified) await this.issueOtp(user, 'reset');
  return { message: GENERIC_OTP_MESSAGE };
}

async resetPassword(email: string, otp: string, newPassword: string) {
  const user = await this.consumeOtp(email, otp, 'reset');
  user.passwordHash = await bcrypt.hash(newPassword, 10);
  user.apiKey = crypto.randomBytes(32).toString('hex'); // rotate → invalidate sessions
  this.clearOtp(user);
  await this.userRepo.save(user);
  return { message: 'Password reset successfully. You can now log in.' };
}

private normalizeEmail(email: string): string {
  return (email || '').trim().toLowerCase();
}

private generateOtp(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

private async issueOtp(user: User, purpose: OtpPurpose): Promise<void> {
  const code = this.generateOtp();
  user.otpHash = await bcrypt.hash(code, 10);
  user.otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);
  user.otpPurpose = purpose;
  user.otpAttempts = 0;
  await this.userRepo.save(user);
  await this.mailService.sendOtp(user.email, code, purpose);
}

private async consumeOtp(email: string, otp: string, expectedPurpose: OtpPurpose): Promise<User> {
  const user = await this.userRepo.findOne({ where: { email: this.normalizeEmail(email) } });
  if (!user || !user.otpHash || !user.otpExpiresAt || user.otpPurpose !== expectedPurpose) {
    throw new BadRequestException('Invalid or expired code');
  }
  if (user.otpExpiresAt.getTime() < Date.now()) {
    this.clearOtp(user); await this.userRepo.save(user);
    throw new BadRequestException('This code has expired. Please request a new one.');
  }
  if (user.otpAttempts >= MAX_OTP_ATTEMPTS) {
    this.clearOtp(user); await this.userRepo.save(user);
    throw new BadRequestException('Too many incorrect attempts. Please request a new code.');
  }
  const isMatch = await bcrypt.compare(otp, user.otpHash);
  if (!isMatch) {
    user.otpAttempts += 1; await this.userRepo.save(user);
    throw new BadRequestException('Invalid or expired code');
  }
  return user;
}

private clearOtp(user: User): void {
  user.otpHash = null;
  user.otpExpiresAt = null;
  user.otpPurpose = null;
  user.otpAttempts = 0;
}
```

Also normalize the email in `login()`/`createUser()` lookups via `this.normalizeEmail(email)`.

## 6. `src/modules/auth/auth.controller.ts` — add `@Public()` endpoints

Import the DTOs and add (each `@Throttle`d like the existing `login`):

```ts
@Public() @Post('signup') @Throttle({ default: { limit: 5, ttl: 60000 } })
async signup(@Body() body: SignupDto) {
  return this.authService.signup(body.email, body.password);
}

@Public() @Post('verify-otp') @Throttle({ default: { limit: 10, ttl: 60000 } })
async verifyOtp(@Body() body: VerifyOtpDto) {
  return this.authService.verifyOtp(body.email, body.otp, 'signup');
}

@Public() @Post('resend-otp') @Throttle({ default: { limit: 3, ttl: 60000 } })
async resendOtp(@Body() body: ResendOtpDto) {
  return this.authService.resendOtp(body.email);
}

@Public() @Post('forgot-password') @Throttle({ default: { limit: 3, ttl: 60000 } })
async forgotPassword(@Body() body: ForgotPasswordDto) {
  return this.authService.forgotPassword(body.email);
}

@Public() @Post('reset-password') @Throttle({ default: { limit: 10, ttl: 60000 } })
async resetPassword(@Body() body: ResetPasswordDto) {
  return this.authService.resetPassword(body.email, body.otp, body.newPassword);
}
```

## 7. `src/modules/auth/auth.module.ts` — import MailModule

```ts
import { MailModule } from '../../common/mail/mail.module';
// imports: [TypeOrmModule.forFeature([User]), MailModule],
```

---

# Frontend (`ES-Studio-UI`)

## 8. `src/lib/api.ts` — add API functions + widen the interceptor skip-list

```ts
export async function signupUser(email: string, password: string) {
  const response = await apiClient.post("/api/auth/signup", { email, password });
  return response.data;
}
export async function verifyOtp(email: string, otp: string) {
  const response = await apiClient.post("/api/auth/verify-otp", { email, otp });
  return response.data;
}
export async function resendOtp(email: string) {
  const response = await apiClient.post("/api/auth/resend-otp", { email });
  return response.data;
}
export async function forgotPassword(email: string) {
  const response = await apiClient.post("/api/auth/forgot-password", { email });
  return response.data;
}
export async function resetPassword(email: string, otp: string, newPassword: string) {
  const response = await apiClient.post("/api/auth/reset-password", { email, otp, newPassword });
  return response.data;
}
```

In the response interceptor, broaden the 401 skip check so public auth calls don't bounce to
`/login`:
```ts
const isAuthCheck = url.includes("/sync-status") || url.includes("/auth/");
```

## 9. `src/hooks/useAuth.ts` and `src/app/components/AppLayoutWrapper.tsx`

Add `/signup` and `/forgot-password` to the public-paths list in both (so they render without
the app chrome and skip the auth check):
```ts
const publicPaths = ["/login", "/signup", "/forgot-password", "/privacy", "/terms"];
```

## 10. `src/app/login/page.tsx`

Add `import Link from "next/link"`, an `info` banner state populated from the URL query
(`?verified=1` / `?reset=1`) via `useEffect`, and footer links:
```tsx
<div className="mt-6 flex flex-col items-center gap-2 text-sm">
  <Link href="/forgot-password" className="text-blue-600 hover:text-blue-700 font-medium">Forgot password?</Link>
  <p className="text-gray-500">Don&apos;t have an account?{" "}
    <Link href="/signup" className="text-blue-600 hover:text-blue-700 font-medium">Sign up</Link>
  </p>
</div>
```

## 11. New pages

Two-step client components (mirror the `/login` card styling):

- `src/app/signup/page.tsx` — Step 1 email + password (client-side check that the email ends
  with `@essentiallysports.com`) → `signupUser`; Step 2 6-digit OTP → `verifyOtp` (with a
  "Resend code" button → `resendOtp`); on success `router.push("/login?verified=1")`.
- `src/app/forgot-password/page.tsx` — Step 1 email → `forgotPassword`; Step 2 OTP + new
  password → `resetPassword` → `router.push("/login?reset=1")`.

Both use `lucide-react` icons, a numeric 6-box OTP input (`inputMode="numeric"`,
`maxLength={6}`, strips non-digits), and the same Tailwind card/input classes as the login page.

---

# Verification checklist (when reimplementing)

1. `cd ES_Studio_API && npm run build` and `cd ES-Studio-UI && npm run build` — both clean.
2. Signup with an `@essentiallysports.com` email → OTP email (or logged code if no SMTP) →
   verify-otp → login sets `auth_token` + `user_role=management`.
3. Non-company email → 400. Login before verify → 401. Forgot → reset (rotates apiKey,
   old sessions rejected) → login with new password.
4. Admin via the curl `setup` command → login works, role `admin`.
5. Drive `/signup` and `/forgot-password` in the browser end-to-end.
