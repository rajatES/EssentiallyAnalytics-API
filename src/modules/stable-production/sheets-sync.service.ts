import { Injectable, Logger } from '@nestjs/common';
import { google } from 'googleapis';
import {
  clean,
  classifyRole,
  computeRowHash,
} from '../production/normalization';
import {
  hasPublishMarker,
  normalizeEditingStatus,
  normalizePieceKind,
  normalizeStablePerson,
  normalizeStableType,
  routeLinks,
  sportOf,
  stageOf,
} from './normalize';
import { ParsedSpPiece, ParsedSpRosterPerson } from './types';

/** Bumped when parsing changes, so the next sync rewrites every row once. */
const SP_PARSE_VERSION = 'sp-2';

type Key =
  | 'player'
  | 'stableType'
  | 'kind'
  | 'title'
  | 'researchDoc'
  | 'writer'
  | 'submissionDoc'
  | 'stagingLink'
  | 'writtenStatus'
  | 'editor'
  | 'editingStatus'
  | 'verificationNote'
  | 'editorComments'
  | 'schedulingTime'
  | 'publishedUrl';

/**
 * Every event tab shares one template, but not one column order — some put
 * Title before New/Updation, some swap the two link columns — so columns are
 * found by header name. "Stable Status" is the older name for New/Updation.
 */
const PATTERNS: { key: Key; match: RegExp }[] = [
  { key: 'player', match: /^player\s*name$/ },
  { key: 'stableType', match: /^stable\s*type$/ },
  { key: 'kind', match: /^(new\s*\/\s*updat\w*|stable\s*status)$/ },
  { key: 'title', match: /^title$/ },
  { key: 'researchDoc', match: /^research\s*doc/ },
  { key: 'writer', match: /^writer\s*name$/ },
  { key: 'submissionDoc', match: /^submission\s*doc/ },
  { key: 'stagingLink', match: /^staging\s*link$/ },
  { key: 'writtenStatus', match: /^written\s*status$/ },
  { key: 'editor', match: /^editor\s*name$/ },
  { key: 'editingStatus', match: /^editing\s*status$/ },
  { key: 'verificationNote', match: /^verification\s*date$/ },
  { key: 'editorComments', match: /^editor\s*comments?$/ },
  { key: 'schedulingTime', match: /^scheduling\s*time$/ },
  { key: 'publishedUrl', match: /^published\s*url$/ },
];

/** How far down a tab to look for its header row; row 1 is a banner. */
const HEADER_SCAN_ROWS = 6;

export interface StableWorkbook {
  pieces: ParsedSpPiece[];
  roster: ParsedSpRosterPerson[];
  /** Visible tabs that are neither an event nor the schedule. */
  skippedTabs: string[];
}

function lowerCells(row: any[] | undefined): string[] {
  return (row || []).map((c) => clean(c).toLowerCase());
}

/** Index of the event header row, or -1 when the tab is not an event tab. */
export function findEventHeader(values: any[][]): number {
  for (let r = 0; r < Math.min(values.length, HEADER_SCAN_ROWS); r++) {
    const cells = lowerCells(values[r]);
    if (
      cells.some((c) => /^player\s*name$/.test(c)) &&
      cells.some((c) => /^writer\s*name$/.test(c))
    ) {
      return r;
    }
  }
  return -1;
}

function findScheduleHeader(values: any[][]): number {
  for (let r = 0; r < Math.min(values.length, HEADER_SCAN_ROWS); r++) {
    const cells = lowerCells(values[r]);
    if (cells.includes('name') && cells.includes('position')) return r;
  }
  return -1;
}

function mapColumns(header: any[]): Partial<Record<Key, number>> {
  const cells = lowerCells(header);
  const claimed = new Set<number>();
  const map: Partial<Record<Key, number>> = {};
  for (const { key, match } of PATTERNS) {
    const idx = cells.findIndex((c, i) => !claimed.has(i) && match.test(c));
    if (idx === -1) continue;
    claimed.add(idx);
    map[key] = idx;
  }
  return map;
}

function shortHash(s: string): string {
  return computeRowHash([s]).slice(0, 12);
}

/**
 * Pieces from one event tab. Exported for offline replay against a workbook
 * export, which is how this parser was checked against the real sheet.
 */
export function parseEventTab(
  tab: string,
  order: number,
  values: any[][],
): ParsedSpPiece[] {
  const h = findEventHeader(values);
  if (h < 0) return [];
  const col = mapColumns(values[h]);
  const banner = values
    .slice(0, h)
    .map((r) => (r || []).map((c) => clean(c)).join(' '))
    .join(' ');
  const sport = sportOf(tab, banner);

  const raw = (row: any[], key: Key): any => {
    const i = col[key];
    return i === undefined ? undefined : row[i];
  };
  const text = (row: any[], key: Key): string => clean(raw(row, key));

  const out: ParsedSpPiece[] = [];
  // The same player and type can legitimately appear twice in a tab (a
  // re-allotment); an occurrence counter keeps their ids apart and stable.
  const seen = new Map<string, number>();

  for (let r = h + 1; r < values.length; r++) {
    const row = values[r] || [];
    const player = text(row, 'player');
    const sheetTitle = text(row, 'title');
    // An allotment is a named player (or, for explainer pieces, a headline).
    // Rows with neither are notes or blanks between blocks.
    if (!player && !sheetTitle) continue;

    const stableType = normalizeStableType(raw(row, 'stableType'));
    const pieceKind = normalizePieceKind(raw(row, 'kind'));
    const { stagingLink, submissionDoc } = routeLinks([
      raw(row, 'stagingLink'),
      raw(row, 'submissionDoc'),
    ]);
    const editingStatus = normalizeEditingStatus(raw(row, 'editingStatus'));
    const publishedUrl = text(row, 'publishedUrl');
    const editorComments = text(row, 'editorComments');
    const verificationNote = text(row, 'verificationNote');
    const writtenStatus = text(row, 'writtenStatus');
    const schedulingRaw = raw(row, 'schedulingTime');

    const published = hasPublishMarker({
      publishedUrl,
      schedulingRaw,
      notes: [editorComments, verificationNote, writtenStatus],
    });
    const stage = stageOf({
      editingStatus,
      stagingLink,
      submissionDoc,
      published,
    });

    const keyBase = [
      tab,
      (player || sheetTitle).toLowerCase(),
      stableType.toLowerCase(),
    ].join('|');
    const n = (seen.get(keyBase) ?? 0) + 1;
    seen.set(keyBase, n);
    const id = 'sp' + shortHash(n > 1 ? `${keyBase}#${n}` : keyBase);

    const title =
      sheetTitle ||
      (player && stableType !== 'Unspecified'
        ? `${player} — ${stableType}`
        : player);

    out.push({
      id,
      event: tab,
      eventOrder: order,
      sport,
      sheetRow: r + 1,
      player: player || sheetTitle,
      stableType,
      pieceKind,
      title,
      hasHeadline: !!sheetTitle,
      writer: normalizeStablePerson(raw(row, 'writer')),
      editor: normalizeStablePerson(raw(row, 'editor')),
      editingStatus,
      stage,
      writtenStatus,
      researchDoc: text(row, 'researchDoc'),
      submissionDoc,
      stagingLink,
      publishedUrl,
      scheduleNote:
        typeof schedulingRaw === 'number' ? 'Scheduled' : clean(schedulingRaw),
      editorComments: editorComments || verificationNote,
      rawHash: computeRowHash([SP_PARSE_VERSION, tab, order, r, ...row]),
    });
  }
  return out;
}

/** The desk from the "Daily Schedule" tab. Phone numbers are never read. */
export function parseSchedule(values: any[][]): ParsedSpRosterPerson[] {
  const h = findScheduleHeader(values);
  if (h < 0) return [];
  const cells = lowerCells(values[h]);
  const find = (re: RegExp) => cells.findIndex((c) => re.test(c));
  const cName = find(/^name$/);
  const cPos = find(/^position$/);
  const cBw = find(/^(bw|bandwidth)$/);
  const cTime = find(/^timings?$/);
  const cShift = find(/^shift$/);
  const cWo = find(/^(wo|week\s*off|weekly\s*offs?)$/);
  const at = (row: any[], i: number) => (i < 0 ? '' : clean(row[i]));

  const out: ParsedSpRosterPerson[] = [];
  let blankRun = 0;
  for (let r = h + 1; r < values.length; r++) {
    const row = values[r] || [];
    const name = at(row, cName);
    if (!name) {
      if (++blankRun >= 3) break;
      continue;
    }
    blankRun = 0;
    const position = at(row, cPos);
    const bw = at(row, cBw);
    const bwNum = bw.match(/^\d+(\.\d+)?/);
    out.push({
      id: 'sr' + shortHash(name.toLowerCase()),
      name,
      position,
      roleGroup: classifyRole(position),
      dailyTarget: bwNum ? Number(bwNum[0]) : null,
      bandwidthNote: bw,
      timings: at(row, cTime),
      shift: at(row, cShift),
      weekoff: at(row, cWo),
      sortOrder: out.length,
      rawHash: computeRowHash([
        SP_PARSE_VERSION,
        name,
        position,
        bw,
        at(row, cTime),
        at(row, cShift),
        at(row, cWo),
      ]),
    });
  }
  return out;
}

@Injectable()
export class SpSheetsSyncService {
  private readonly logger = new Logger(SpSheetsSyncService.name);

  private sheetsApi() {
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    return google.sheets({ version: 'v4', auth });
  }

  /**
   * Reads every visible tab and keeps the ones that carry the event template,
   * so a new event tab is picked up on the next sync with no configuration.
   * Hidden tabs are the desk's archive, pivots and research lists.
   */
  async fetchWorkbook(): Promise<StableWorkbook | null> {
    const spreadsheetId = process.env.STABLE_SHEET_ID;
    if (!spreadsheetId) {
      this.logger.warn('STABLE_SHEET_ID not configured, skipping Stable sync');
      return null;
    }
    const includeHidden = process.env.STABLE_INCLUDE_HIDDEN === 'true';
    const sheets = this.sheetsApi();

    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties(title,index,hidden)',
    });
    const tabs = (meta.data.sheets ?? [])
      .map((s) => s.properties ?? {})
      .filter((p) => p.title && (includeHidden || !p.hidden))
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (!tabs.length) return { pieces: [], roster: [], skippedTabs: [] };

    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: tabs.map(
        (t) => `'${String(t.title).replace(/'/g, "''")}'!A1:AF3000`,
      ),
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER',
    });

    const pieces: ParsedSpPiece[] = [];
    let roster: ParsedSpRosterPerson[] = [];
    const skippedTabs: string[] = [];
    (res.data.valueRanges ?? []).forEach((vr, i) => {
      const tab = String(tabs[i].title);
      const values = vr.values ?? [];
      if (findEventHeader(values) >= 0) {
        pieces.push(...parseEventTab(tab, tabs[i].index ?? i, values));
      } else if (!roster.length && findScheduleHeader(values) >= 0) {
        roster = parseSchedule(values);
      } else {
        skippedTabs.push(tab);
      }
    });

    return { pieces, roster, skippedTabs };
  }
}
