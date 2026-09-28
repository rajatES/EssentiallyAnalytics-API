-- utm_term label on UTM page mappings ('autopost' marks the automation
-- division's posts), shown on Traffic → Mappings. Display only — nothing
-- matches on it.
--
-- Run by hand BEFORE deploying the matching API build. Without the column,
-- every page_mappings read fails, which takes down the Traffic page and the
-- emailed traffic CSV along with the mappings screen:
--
--   docker exec -i social_postgres psql -U postgres -d social_studio_db \
--     < seeds/004-page-mapping-utm-term.sql
--
-- Safe to re-run.

ALTER TABLE page_mappings
  ADD COLUMN IF NOT EXISTS "utmTerm" VARCHAR DEFAULT NULL;
