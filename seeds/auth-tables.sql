-- Auth: emailed sign-up / reset codes, and the two login-tracking columns.
--
-- Production runs with synchronize off, so TypeORM will not create these:
--
--   psql "$DATABASE_URL" -f seeds/auth-tables.sql
--
-- Run it BEFORE deploying the new API. Without `auth_otp` every sign-up and
-- password reset fails at the first step; without the two `users` columns
-- login itself fails, because the service stamps `lastLoginAt` on success.
--
-- Column names are quoted because the entities use camelCase. Every statement
-- is idempotent, so it is safe on a database where DB_SYNC already created
-- some of this.

-- ── One emailed code, and the setup token it is exchanged for ──
--
-- Neither the code nor the token is stored in plaintext, only an HMAC of each,
-- so a database dump hands an attacker nothing live.
CREATE TABLE IF NOT EXISTS auth_otp (
  "id"              bigserial PRIMARY KEY,
  "email"           character varying NOT NULL,
  "codeHash"        character varying NOT NULL,
  "ip"              character varying,
  "attempts"        integer NOT NULL DEFAULT 0,
  "expiresAt"       timestamptz NOT NULL,
  -- Set when the code is verified; a code verifies once.
  "consumedAt"      timestamptz,
  -- Set when a newer code, an expiry or the attempt cap retires this one.
  "invalidatedAt"   timestamptz,
  "setupTokenHash"  character varying,
  "setupExpiresAt"  timestamptz,
  "setupUsedAt"     timestamptz,
  "createdAt"       timestamptz NOT NULL DEFAULT now()
);

-- The two rate limits are counted over these, per address and per IP.
CREATE INDEX IF NOT EXISTS auth_otp_email_created_idx ON auth_otp ("email", "createdAt");
CREATE INDEX IF NOT EXISTS auth_otp_ip_created_idx    ON auth_otp ("ip", "createdAt");
-- Step 3 looks the row up by the token it was handed.
CREATE INDEX IF NOT EXISTS auth_otp_setup_token_idx   ON auth_otp ("setupTokenHash");

-- ── users: two nullable columns, no change to anything existing ──
--
-- `role` already holds free text, so 'superadmin' needs no migration.
ALTER TABLE users ADD COLUMN IF NOT EXISTS "lastLoginAt"       timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "passwordUpdatedAt" timestamptz;
