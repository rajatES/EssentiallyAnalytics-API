-- Stable Production tables — what TypeORM would create with DB_SYNC=true,
-- written out so production (which keeps synchronize off) can create them once:
--
--   docker exec -i social_postgres psql -U postgres -d social_studio_db \
--     < seeds/stable-production-tables.sql
--
-- Run before deploying the matching API build, or every Stable sync fails.
-- Column names are quoted because the entities use camelCase, matching every
-- other table in this schema. All statements are idempotent.

-- ── One row per stable piece, mirrored from the Stable workbook ──
--
-- Each source tab is one event. The sheet keeps no reliable timestamps, so
-- there are no time columns: every figure is where a piece stands now.
CREATE TABLE IF NOT EXISTS sp_pieces (
  "id"             character varying PRIMARY KEY,
  "event"          character varying NOT NULL,
  "eventOrder"     integer NOT NULL DEFAULT 0,
  "sport"          character varying NOT NULL DEFAULT 'Other',
  "sheetRow"       integer NOT NULL DEFAULT 0,
  "player"         text NOT NULL DEFAULT '',
  "stableType"     character varying NOT NULL DEFAULT 'Unspecified',
  "pieceKind"      character varying NOT NULL DEFAULT '',
  "title"          text NOT NULL DEFAULT '',
  "hasHeadline"    boolean NOT NULL DEFAULT false,
  "writer"         character varying NOT NULL DEFAULT 'Unknown',
  "editor"         character varying NOT NULL DEFAULT 'Unknown',
  "editingStatus"  character varying NOT NULL DEFAULT '',
  "stage"          character varying NOT NULL DEFAULT 'Awaiting Submission',
  "writtenStatus"  text NOT NULL DEFAULT '',
  "researchDoc"    text NOT NULL DEFAULT '',
  "submissionDoc"  text NOT NULL DEFAULT '',
  "stagingLink"    text NOT NULL DEFAULT '',
  "publishedUrl"   text NOT NULL DEFAULT '',
  "scheduleNote"   text NOT NULL DEFAULT '',
  "editorComments" text NOT NULL DEFAULT '',
  "rawHash"        text NOT NULL DEFAULT '',
  "createdAt"      timestamp NOT NULL DEFAULT now(),
  "updatedAt"      timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sp_pieces_event       ON sp_pieces ("event");
CREATE INDEX IF NOT EXISTS idx_sp_pieces_sport       ON sp_pieces ("sport");
CREATE INDEX IF NOT EXISTS idx_sp_pieces_stable_type ON sp_pieces ("stableType");
CREATE INDEX IF NOT EXISTS idx_sp_pieces_writer      ON sp_pieces ("writer");
CREATE INDEX IF NOT EXISTS idx_sp_pieces_editor      ON sp_pieces ("editor");
CREATE INDEX IF NOT EXISTS idx_sp_pieces_stage       ON sp_pieces ("stage");

-- ── The desk, from the workbook's "Daily Schedule" tab (no phone numbers) ──
CREATE TABLE IF NOT EXISTS sp_roster (
  "id"            character varying PRIMARY KEY,
  "name"          character varying NOT NULL,
  "position"      character varying NOT NULL DEFAULT '',
  "roleGroup"     character varying NOT NULL DEFAULT 'other',
  "dailyTarget"   real,
  "bandwidthNote" character varying NOT NULL DEFAULT '',
  "timings"       character varying NOT NULL DEFAULT '',
  "shift"         character varying NOT NULL DEFAULT '',
  "weekoff"       character varying NOT NULL DEFAULT '',
  "sortOrder"     integer NOT NULL DEFAULT 0,
  "rawHash"       text NOT NULL DEFAULT ''
);
