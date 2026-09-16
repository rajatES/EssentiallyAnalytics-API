-- Click-through links for page names on the Traffic, Reports and Revenue pages.
--
-- Prod runs with synchronize=false, so TypeORM will NOT add these columns by
-- itself. Run this by hand before deploying the matching API build — the
-- page-directory endpoint selects `username` and both `pageUrl` columns, and
-- will 500 on every request until they exist:
--
--   docker exec -i social_postgres psql -U postgres -d social_studio_db \
--     < seeds/003-page-links.sql
--
-- Safe to re-run.

-- Instagram's profile URL uses the handle, not the account id we store in
-- `profileId`, so Instagram names stay unlinkable until this is populated.
-- Backfill the values with: POST /api/analytics/profiles/refresh-usernames
ALTER TABLE social_profiles
  ADD COLUMN IF NOT EXISTS username VARCHAR;

-- Manual override for traffic rows, which carry a page name and no identifier.
-- The only way to link a Threads account, or any page whose traffic name
-- differs from the name Meta reports.
ALTER TABLE page_mappings
  ADD COLUMN IF NOT EXISTS "pageUrl" TEXT;

-- Rarely needed: revenue rows already resolve from their Meta Page ID.
ALTER TABLE revenue_mappings
  ADD COLUMN IF NOT EXISTS "pageUrl" TEXT;
