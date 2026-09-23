-- Yahoo Production tables — what TypeORM would create with DB_SYNC=true,
-- written out so production (which keeps synchronize off) can create them once:
--
--   psql "$DATABASE_URL" -f seeds/yahoo-production-tables.sql
--
-- Column names are quoted because the entities use camelCase, matching every
-- other table in this schema. All statements are idempotent.

-- ── Content pieces, one row per piece from the aggregate sheet ──
--
-- Yahoo runs a single editorial pass with no send-back loop, so there is no
-- second editor, second status or rework duration here. "editorAt" is the
-- automated publishing stamp: in a one-pass pipeline, publication is the end
-- of the editorial pass.
CREATE TABLE IF NOT EXISTS yp_pieces (
  "id"              character varying PRIMARY KEY,
  "uniquePieceId"   text NOT NULL DEFAULT '',
  "division"        character varying NOT NULL DEFAULT 'Unknown',
  "month"           character varying NOT NULL DEFAULT '',
  "writer"          character varying NOT NULL DEFAULT 'Unknown',
  "editor"          character varying NOT NULL DEFAULT 'Unknown',
  "allottedBy"      character varying NOT NULL DEFAULT 'Unknown',
  "articleType"     character varying NOT NULL DEFAULT 'Unknown',
  "enhancement"     character varying NOT NULL DEFAULT '',
  "editorialStatus" character varying NOT NULL DEFAULT 'Unknown',
  "wpStatus"        character varying NOT NULL DEFAULT '',
  "allottedAt"      timestamptz,
  "submittedAt"     timestamptz,
  "editorAt"        timestamptz,
  "liveAt"          timestamptz,
  "wpCheckedAt"     timestamptz,
  "publishedDate"   date,
  "date"            date,
  "tatHours"        real,
  "title"           text NOT NULL DEFAULT '',
  "titleNorm"       text NOT NULL DEFAULT '',
  "source"          text NOT NULL DEFAULT '',
  "stagingLink"     text NOT NULL DEFAULT '',
  "writerComments"  text NOT NULL DEFAULT '',
  "editorComment"   text NOT NULL DEFAULT '',
  "plagReport"      text NOT NULL DEFAULT '',
  "rawHash"         text NOT NULL DEFAULT '',
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  "updatedAt"       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_yp_pieces_division      ON yp_pieces ("division");
CREATE INDEX IF NOT EXISTS idx_yp_pieces_month         ON yp_pieces ("month");
CREATE INDEX IF NOT EXISTS idx_yp_pieces_writer        ON yp_pieces ("writer");
CREATE INDEX IF NOT EXISTS idx_yp_pieces_editor        ON yp_pieces ("editor");
CREATE INDEX IF NOT EXISTS idx_yp_pieces_allotted_by   ON yp_pieces ("allottedBy");
CREATE INDEX IF NOT EXISTS idx_yp_pieces_article_type  ON yp_pieces ("articleType");
CREATE INDEX IF NOT EXISTS idx_yp_pieces_enhancement   ON yp_pieces ("enhancement");
CREATE INDEX IF NOT EXISTS idx_yp_pieces_status        ON yp_pieces ("editorialStatus");
CREATE INDEX IF NOT EXISTS idx_yp_pieces_published     ON yp_pieces ("publishedDate");
CREATE INDEX IF NOT EXISTS idx_yp_pieces_date          ON yp_pieces ("date");
CREATE INDEX IF NOT EXISTS idx_yp_pieces_title_norm    ON yp_pieces ("titleNorm");

-- ── Editorial roster ("Yahoo Ed. Team") ──
--
-- Only editors are rostered; writers appear on the content rows and nowhere
-- else. The newsroom block from the same tab arrives with team = 'Newsroom'.
CREATE TABLE IF NOT EXISTS yp_editors (
  "id"        character varying PRIMARY KEY,
  "name"      character varying NOT NULL DEFAULT '',
  "division"  character varying NOT NULL DEFAULT '',
  "role"      character varying NOT NULL DEFAULT '',
  "roleGroup" character varying NOT NULL DEFAULT '',
  "timing"    character varying NOT NULL DEFAULT '',
  "shift"     character varying NOT NULL DEFAULT '',
  "weekoff"   character varying NOT NULL DEFAULT '',
  "team"      character varying NOT NULL DEFAULT '',
  "rawHash"   text NOT NULL DEFAULT '',
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_yp_editors_name     ON yp_editors ("name");
CREATE INDEX IF NOT EXISTS idx_yp_editors_division ON yp_editors ("division");
CREATE INDEX IF NOT EXISTS idx_yp_editors_team     ON yp_editors ("team");

-- ── Daily piece quota per division ──
--
-- "divisions" is the expanded list, because one row can cover two content
-- divisions ("Tennis+Olympics"). simple-array is stored as a comma-joined text
-- column by TypeORM.
CREATE TABLE IF NOT EXISTS yp_division_quotas (
  "id"        character varying PRIMARY KEY,
  "division"  character varying NOT NULL DEFAULT '',
  "divisions" text NOT NULL DEFAULT '',
  "quota"     integer,
  "window"    character varying NOT NULL DEFAULT '',
  "poc"       character varying NOT NULL DEFAULT '',
  "rawHash"   text NOT NULL DEFAULT '',
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
