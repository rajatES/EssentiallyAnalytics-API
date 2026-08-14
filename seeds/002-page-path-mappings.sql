-- Landing-page (URL pattern) mappings. Backs the "Landing Pages" tab in
-- Traffic → Mappings, and the page/team columns in the Top Landing Pages panel.
--
-- Production currently runs with DB_SYNC=true, so TypeORM creates the table
-- itself and only the seed rows below actually need this file. Run it by hand:
--
--   docker exec -i social_postgres psql -U postgres -d social_studio_db \
--     < seeds/002-page-path-mappings.sql
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS page_path_mappings (
  id         SERIAL PRIMARY KEY,
  pattern    TEXT NOT NULL,
  "pageName" VARCHAR NOT NULL,
  category   VARCHAR NOT NULL DEFAULT 'Uncategorized',
  team       VARCHAR,
  priority   INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "UQ_page_path_mappings_pattern" UNIQUE (pattern)
);

-- Optional starting set, derived from the sections that actually carry traffic.
-- '*' is the only wildcard. Delete or edit these freely in the UI.
INSERT INTO page_path_mappings (pattern, "pageName", category, team, priority) VALUES
  ('/nba-*',    'NBA Content',    'NBA',    NULL, 0),
  ('/wnba-*',   'WNBA Content',   'WNBA',   NULL, 0),
  ('/nfl-*',    'NFL Content',    'NFL',    NULL, 0),
  ('/nf-*',     'NFL Content',    'NFL',    NULL, 10),
  ('/ncaa-*',   'NCAA Content',   'NCAA',   NULL, 0),
  ('/golf-*',   'Golf Content',   'Golf',   NULL, 0),
  ('/ufc-*',    'UFC Content',    'MMA',    NULL, 0),
  ('/boxing-*', 'Boxing Content', 'Boxing', NULL, 0),
  ('/nascar-*', 'NASCAR Content', 'NASCAR', NULL, 0),
  ('/tennis-*', 'Tennis Content', 'Tennis', NULL, 0)
ON CONFLICT (pattern) DO NOTHING;
