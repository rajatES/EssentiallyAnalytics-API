-- Critical Flow tables — what TypeORM would create with DB_SYNC=true, written
-- out so production (which keeps synchronize off) can create them once:
--
--   psql "$DATABASE_URL" -f seeds/critical-flow-tables.sql
--
-- Column names are quoted because the entities use camelCase, matching every
-- other table in this schema. All statements are idempotent.

-- ── Content pieces, one row per piece from the aggregate sheet ──
CREATE TABLE IF NOT EXISTS cf_pieces (
  "id"               character varying PRIMARY KEY,
  "uniquePieceId"    text NOT NULL DEFAULT '',
  "division"         character varying NOT NULL DEFAULT 'Unknown',
  "month"            character varying NOT NULL DEFAULT '',
  "writer"           character varying NOT NULL DEFAULT 'Unknown',
  "editor"           character varying NOT NULL DEFAULT 'Unknown',
  "editor2"          character varying NOT NULL DEFAULT '',
  "allottedBy"       character varying NOT NULL DEFAULT 'Unknown',
  "articleType"      character varying NOT NULL DEFAULT 'Unknown',
  "yahoo"            boolean,
  "editorialStatus"  character varying NOT NULL DEFAULT 'Unknown',
  "editorialStatus2" character varying NOT NULL DEFAULT '',
  "sbReason"         character varying NOT NULL DEFAULT '',
  "wpStatus"         character varying NOT NULL DEFAULT '',
  "allottedAt"       timestamptz,
  "submittedAt"      timestamptz,
  "submittedEst"     timestamptz,
  "editorAt"         timestamptz,
  "editorAt2"        timestamptz,
  "liveAt"           timestamptz,
  "wpCheckedAt"      timestamptz,
  "publishedDate"    date,
  "date"             date,
  "tatHours"         real,
  "sbHours"          real,
  "title"            text NOT NULL DEFAULT '',
  "titleNorm"        text NOT NULL DEFAULT '',
  "source"           text NOT NULL DEFAULT '',
  "stagingLink"      text NOT NULL DEFAULT '',
  "writerComments"   text NOT NULL DEFAULT '',
  "editorComment"    text NOT NULL DEFAULT '',
  "editorComment2"   text NOT NULL DEFAULT '',
  "articleMap"       text NOT NULL DEFAULT '',
  "plagReport"       text NOT NULL DEFAULT '',
  "rawHash"          text NOT NULL DEFAULT '',
  "createdAt"        timestamp NOT NULL DEFAULT now(),
  "updatedAt"        timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cf_pieces_division_idx        ON cf_pieces ("division");
CREATE INDEX IF NOT EXISTS cf_pieces_month_idx           ON cf_pieces ("month");
CREATE INDEX IF NOT EXISTS cf_pieces_writer_idx          ON cf_pieces ("writer");
CREATE INDEX IF NOT EXISTS cf_pieces_editor_idx          ON cf_pieces ("editor");
CREATE INDEX IF NOT EXISTS cf_pieces_editor2_idx         ON cf_pieces ("editor2");
CREATE INDEX IF NOT EXISTS cf_pieces_allottedby_idx      ON cf_pieces ("allottedBy");
CREATE INDEX IF NOT EXISTS cf_pieces_articletype_idx     ON cf_pieces ("articleType");
CREATE INDEX IF NOT EXISTS cf_pieces_yahoo_idx           ON cf_pieces ("yahoo");
CREATE INDEX IF NOT EXISTS cf_pieces_editorialstatus_idx ON cf_pieces ("editorialStatus");
CREATE INDEX IF NOT EXISTS cf_pieces_sbreason_idx        ON cf_pieces ("sbReason");
CREATE INDEX IF NOT EXISTS cf_pieces_publisheddate_idx   ON cf_pieces ("publishedDate");
CREATE INDEX IF NOT EXISTS cf_pieces_date_idx            ON cf_pieces ("date");
CREATE INDEX IF NOT EXISTS cf_pieces_titlenorm_idx       ON cf_pieces ("titleNorm");

-- ── Per-division rosters, from each source sheet's Division Info tab ──
CREATE TABLE IF NOT EXISTS cf_roster (
  "id"          character varying PRIMARY KEY,
  "division"    character varying NOT NULL DEFAULT 'Unknown',
  "name"        character varying NOT NULL,
  "role"        character varying NOT NULL DEFAULT '',
  "roleGroup"   character varying NOT NULL DEFAULT 'other',
  "weekoff"     character varying NOT NULL DEFAULT '',
  "shift"       character varying NOT NULL DEFAULT '',
  "email"       character varying NOT NULL DEFAULT '',
  "dailyTarget" real,
  "rawHash"     character varying NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS cf_roster_division_idx  ON cf_roster ("division");
CREATE INDEX IF NOT EXISTS cf_roster_rolegroup_idx ON cf_roster ("roleGroup");

-- ── People as the managers' Dynamic Schedule workbook describes them ──
CREATE TABLE IF NOT EXISTS cf_schedule_person (
  "id"                 character varying PRIMARY KEY,
  "name"               character varying NOT NULL,
  "primaryDivision"    character varying NOT NULL DEFAULT 'Unknown',
  "subFeed"            character varying NOT NULL DEFAULT '',
  "secondaryDivisions" text NOT NULL DEFAULT '',
  "role"               character varying NOT NULL DEFAULT '',
  "roleGroup"          character varying NOT NULL DEFAULT 'other',
  "pod"                character varying NOT NULL DEFAULT '',
  "shift"              character varying NOT NULL DEFAULT '',
  "shiftClock"         character varying NOT NULL DEFAULT '',
  "weekoff"            character varying NOT NULL DEFAULT '',
  "weekPlan"           text NOT NULL DEFAULT '{}',
  "backup"             character varying NOT NULL DEFAULT '',
  "status"             character varying NOT NULL DEFAULT '',
  "sources"            character varying NOT NULL DEFAULT '',
  "flags"              character varying NOT NULL DEFAULT '',
  "rawHash"            character varying NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS cf_schedule_person_name_idx      ON cf_schedule_person ("name");
CREATE INDEX IF NOT EXISTS cf_schedule_person_division_idx  ON cf_schedule_person ("primaryDivision");
CREATE INDEX IF NOT EXISTS cf_schedule_person_rolegroup_idx ON cf_schedule_person ("roleGroup");

-- ── Leave records from the CF Writer / Editor Leaves logs ──
CREATE TABLE IF NOT EXISTS cf_leave (
  "id"         character varying PRIMARY KEY,
  "name"       character varying NOT NULL,
  "roleTag"    character varying NOT NULL DEFAULT '',
  "leaveStart" date NOT NULL,
  "leaveEnd"   date NOT NULL,
  "days"       real,
  "type"       character varying NOT NULL DEFAULT '',
  "loggedAt"   timestamptz,
  "rawHash"    character varying NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS cf_leave_name_idx ON cf_leave ("name");

-- ── Per-shift division quotas from the DailyDynamics tab ──
CREATE TABLE IF NOT EXISTS cf_division_quota (
  "id"                  character varying PRIMARY KEY,
  "division"            character varying NOT NULL,
  "subFeed"             character varying NOT NULL DEFAULT '',
  "sourceName"          character varying NOT NULL DEFAULT '',
  "emp"                 integer NOT NULL DEFAULT 0,
  "lnp"                 integer NOT NULL DEFAULT 0,
  "total"               integer NOT NULL DEFAULT 0,
  "editorialChartTotal" integer,
  "poc"                 character varying NOT NULL DEFAULT '',
  "architecture"        character varying NOT NULL DEFAULT '',
  "rawHash"             character varying NOT NULL DEFAULT ''
);

-- ── The one in-app table: per-person daily quota, edited from /cf-resources ──
CREATE TABLE IF NOT EXISTS cf_resource_profile (
  "id"         character varying PRIMARY KEY,
  "division"   character varying NOT NULL,
  "name"       character varying NOT NULL,
  "dailyQuota" integer,
  "notes"      text NOT NULL DEFAULT '',
  "updatedAt"  timestamp NOT NULL DEFAULT now()
);
