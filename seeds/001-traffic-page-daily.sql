-- Landing-page traffic aggregate. Backs the "Top Landing Pages" panel.
--
-- Production runs with synchronize=false (DB_SYNC is unset in .env.production),
-- so entities do not create their own tables there. Run this once against the
-- production database before deploying the code that reads it:
--
--   docker exec -i social_postgres psql -U postgres -d social_studio_db \
--     < seeds/001-traffic-page-daily.sql
--
-- Safe to re-run: every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS traffic_page_daily (
  id            SERIAL PRIMARY KEY,
  "dimensionHash" VARCHAR NOT NULL,
  date          DATE NOT NULL,
  "utmSource"   VARCHAR NOT NULL DEFAULT '(direct)',
  "pagePath"    TEXT NOT NULL,
  sessions      INTEGER NOT NULL DEFAULT 0,
  pageviews     INTEGER NOT NULL DEFAULT 0,
  users         INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "UQ_traffic_page_daily_dimensionHash" UNIQUE ("dimensionHash")
);

-- Matches the entity's @Index(['date','utmSource']) and @Index() on date.
CREATE INDEX IF NOT EXISTS "IDX_traffic_page_daily_date_source"
  ON traffic_page_daily (date, "utmSource");
CREATE INDEX IF NOT EXISTS "IDX_traffic_page_daily_date"
  ON traffic_page_daily (date);
