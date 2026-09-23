# Auth: sign-up by emailed code, roles, and the super user

Anyone with an `@essentiallysports.com` address can create an account. Everyone
starts as a **User**; one **super user**, defined in the API's environment, moves
people between User, Manager and Admin.

> An earlier self-service sign-up (password first, then verify; sign-ups became
> Managers) was built, reverted and parked in this file. It is replaced by the flow
> below; the old kit is in git history.

## Flow

```
/signup                        /signup?mode=reset  ("Forgot password?")
  1. ES email ──► POST /api/auth/code           { email, purpose }
  2. 6-digit code ──► POST /api/auth/code/verify { email, code } → { setupToken, hasAccount }
  3. password ──► POST /api/auth/password        { email, setupToken, password }
                   creates the account (role user) or resets it, and signs in
/login  ──► POST /api/auth/login (unchanged)
```

- One flow serves sign-up and reset. Step 1 answers the same way whether or not the
  address has an account, so it can't be used to list who does; step 2 tells the
  mailbox owner which case they are in.
- Codes: 6 digits, 10-minute life, single use, stored only as an HMAC. One live code
  per address; 5 wrong guesses kill it (counted atomically, so parallel guesses can't
  slip past); 3 requests per address per 15 min, 10 per IP per hour. Ported from
  es-mcp's `utilities/otp.ts`.
- A verified code becomes a **setup token** (15 minutes, single use), which is what
  step 3 presents. A reset rotates the session key, signing the account out
  everywhere else.
- Passwords: 8–72 characters (bcrypt reads only 72 bytes).
- Login and lookups ignore email case, so accounts created by the old `setup`
  endpoint with mixed case still work.

## Roles

| Role | Stored as | Gets |
| --- | --- | --- |
| Super user | `superadmin` | Everything, plus the **Access** page (`/users`) |
| Admin | `admin` | Sync buttons (CF, Yahoo, MSN, Meta, BigQuery), MSN report targets, delete-all mappings |
| Manager | `management` | Resource quotas, Meta connect/disconnect, email-report recipients |
| User | `user` | Every dashboard, read-only for the above |

Roles are now enforced **on the API**, not just hidden in the UI: `@MinRole(...)` on
a route is checked by the global `ApiKeyGuard` after authentication, and a higher
role passes every lower check. The routes gated are exactly the ones the UI already
hid, so nobody loses anything they could use before. Machine-called routes (MSN
ingest, backfills, imports) are deliberately left ungated.

A role change applies on the person's next request — the guard reads the role from
the database each time, and `/api/auth/me` refreshes the UI's `user_role` cookie.

### The super user

- `SUPERADMIN_EMAIL` + `SUPERADMIN_PASSWORD` (12–72 chars) are applied on every
  boot: the account is created if missing, its password re-hashed if the env
  changed (which signs out its old sessions), and any other `superadmin` is demoted
  to `user` — there is only ever one.
- It can't be edited or demoted through the API, can't use the emailed-code flow,
  and `superadmin` can't be assigned to anyone.
- Access page API: `GET /api/users`, `PATCH /api/users/:id/role { role }`.

## Configuration

API env (see `.env.production.example`):

| Var | |
| --- | --- |
| `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD` | The super user. Unset → nobody can change roles (logged at boot). |
| `OTP_SIGNING_SECRET` | HMAC key for codes and setup tokens. Unset → sign-up returns 503. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Same transport as email reports (`common/mail/mail.service.ts`). Unset → sign-up returns 503. |
| `ACCESS_EMAIL_DOMAIN` | Optional, default `essentiallysports.com`. |
| `AUTH_DEV_LOG_CODES=true` | Local only: with no SMTP, print codes to the server log. Refused when `NODE_ENV=production`. |

Schema — created by TypeORM with `DB_SYNC=true`: table `auth_otp`, and nullable
columns `users."lastLoginAt"`, `users."passwordUpdatedAt"`. No existing column
changes, and the `role` column already holds free text, so `superadmin` needs no
migration.

The `SETUP_SECRET` endpoint still works for creating accounts by curl (any domain),
except that it refuses to create a super user.

## Files

API: `modules/auth/{auth.service,auth.controller,users.controller,otp.service,otp-email,roles}.ts`,
`modules/auth/entities/{user,auth-otp}.entity.ts`, `common/decorators/min-role.decorator.ts`,
`common/guards/api-key.guard.ts`, `common/mail/*`, `common/dto/signup.dto.ts`.

UI: `app/signup/page.tsx`, `app/users/page.tsx`, `app/login/page.tsx`,
`hooks/useRole.tsx`, `lib/api.ts`, `lib/public-routes.ts`, `components/{Sidebar,Topbar}.tsx`.

## Verified

End-to-end against the real `AuthModule` over HTTP on an in-memory Postgres
(pg-mem): 52 checks covering sign-up, reset, rate limits, the attempt cap under 12
parallel guesses, single-use codes and tokens, role gating, super-user rotation and
the dev-logging flag. The UI flow (sign up → Access page → promote) was driven in
the browser against the same server.
