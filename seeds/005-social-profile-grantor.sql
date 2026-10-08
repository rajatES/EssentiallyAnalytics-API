-- Records which Facebook account granted each connected page, so Settings can
-- hold pages from several Facebook logins at once and disconnect them per
-- account.
--
-- Run by hand BEFORE deploying the matching API build. Without the columns,
-- every social_profiles read fails — that takes down Settings, the sync cron
-- and every Meta-backed page:
--
--   docker exec -i social_postgres psql -U postgres -d social_studio_db \
--     < seeds/005-social-profile-grantor.sql
--
-- Safe to re-run. Existing rows stay NULL and show as "Earlier connection"
-- until the Facebook account that added them reconnects once.

ALTER TABLE social_profiles
  ADD COLUMN IF NOT EXISTS "connectedViaId" VARCHAR DEFAULT NULL;

ALTER TABLE social_profiles
  ADD COLUMN IF NOT EXISTS "connectedViaName" VARCHAR DEFAULT NULL;
