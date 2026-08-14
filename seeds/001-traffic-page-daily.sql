-- Landing-page traffic aggregate. Backs the "Top Landing Pages" panel.
--
-- Production currently runs with DB_SYNC=true, so TypeORM creates this table
-- from the entity on boot and this file is not strictly required there. It
-- exists so the schema is reproducible without relying on synchronize — which
-- should be turned off in production, since it lets a deploy alter or drop
-- columns to match an entity.
--
-- Run it by hand on any environment where synchronize is off:
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
