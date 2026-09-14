import { Injectable, Logger } from '@nestjs/common';
import { google } from 'googleapis';
import { ParsedPiece, ParsedRosterPerson } from './types';
import {
  clean,
  classifyRole,
  computeRowHash,
  isValidPiece,
  normalizeArticleType,
  normalizeDivision,
  normalizePerson,
  normalizeSbReason,
  normalizeStatus,
  normalizeTitleKey,
  parseDateOnly,
  parseDateTime,
  parseNumber,
  parseYahoo,
  toDateOnly,
} from './normalization';

type PieceKey =
  | 'id' | 'uniquePieceId' | 'division' | 'month' | 'allottedBy' | 'writer'
  | 'allottedAt' | 'title' | 'source' | 'stagingLink' | 'writerComments'
  | 'submittedAt' | 'submittedEst' | 'yahoo' | 'articleType' | 'articleMap'
  | 'plagReport' | 'editor' | 'editorialStatus' | 'sbReason' | 'editorComment'
  | 'editorAt' | 'sbHours' | 'editor2' | 'editorialStatus2' | 'editorComment2'
  | 'editorAt2' | 'tatHours' | 'publishedDate' | 'liveAt' | 'wpStatus'
  | 'wpCheckedAt' | 'kind';

/**
 * Header patterns for the aggregate sheet's Sheet1. Each claims the first
 * not-yet-claimed matching header, so the paired first/second editorial pass
 * columns resolve in order even though their names are near-identical.
 */
const PIECE_PATTERNS: { key: PieceKey; match: RegExp; required?: boolean }[] = [
  { key: 'id', match: /^id$/i, required: true },
  { key: 'uniquePieceId', match: /^unique\s*piece\s*id$/i },
  { key: 'division', match: /^division$/i, required: true },
  { key: 'month', match: /^month$/i },
  { key: 'allottedBy', match: /^allot(t)?ed\s*by$/i },
  { key: 'writer', match: /^writer$/i },
  { key: 'allottedAt', match: /^allot(t)?ed\s*at$/i },
  { key: 'title', match: /^title$/i, required: true },
  { key: 'source', match: /^source$/i },
  { key: 'stagingLink', match: /^staging\s*link$/i },
  { key: 'writerComments', match: /^writer\s*comments?$/i },
  { key: 'submittedAt', match: /^submitted\s*at$/i },
  { key: 'submittedEst', match: /^submitted\s*est$/i },
  { key: 'yahoo', match: /^yahoo$/i },
  { key: 'articleType', match: /^article\s*type$/i },
  { key: 'articleMap', match: /^article\s*map$/i },
  { key: 'plagReport', match: /^plag\s*report$/i },
  // Ordered so the first-pass trio claims its columns before the "2" variants.
  { key: 'editorialStatus2', match: /^editorial\s*status\s*2$/i },
  { key: 'editorComment2', match: /^editor\s*comment\s*2$/i },
  { key: 'editorAt2', match: /^editor\s*2\s*at$/i },
  { key: 'editor2', match: /^editor\s*2$/i },
  { key: 'editorialStatus', match: /^editorial\s*status$/i },
  { key: 'sbReason', match: /^sb\s*reason$/i },
  { key: 'editorComment', match: /^editor\s*comment$/i },
  { key: 'editorAt', match: /^editor\s*at$/i },
  { key: 'editor', match: /^editor$/i },
  { key: 'sbHours', match: /^sb\s*hours$/i },
  { key: 'tatHours', match: /^tat\s*hours$/i },
  { key: 'publishedDate', match: /^published\s*date$/i },
  { key: 'liveAt', match: /^live\s*at$/i },
  { key: 'wpStatus', match: /^wp\s*status$/i },
  { key: 'wpCheckedAt', match: /^wp\s*last\s*checked$/i },
  { key: 'kind', match: /^__kind$/i },
];

type RosterKey =
  | 'id' | 'division' | 'name' | 'role' | 'weekoff' | 'shift' | 'email' | 'target' | 'kind';

const ROSTER_PATTERNS: { key: RosterKey; match: RegExp; required?: boolean }[] = [
  { key: 'id', match: /^id$/i, required: true },
  { key: 'division', match: /^division$/i },
  { key: 'name', match: /^name$/i, required: true },
  { key: 'role', match: /^role$/i },
  { key: 'weekoff', match: /^week\s*-?\s*off$/i },
  { key: 'shift', match: /^shift$/i },
  { key: 'email', match: /^email$/i },
  { key: 'target', match: /^daily\s*target$/i },
  { key: 'kind', match: /^__kind$/i },
];

@Injectable()
export class CfSheetsSyncService {
  private readonly logger = new Logger(CfSheetsSyncService.name);

  private getAuth() {
    return new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  }

  /** Canonical-key → column-index map, or null if a required column is absent. */
  private matchHeaders<K extends string>(
    headerRow: any[],
    patterns: { key: K; match: RegExp; required?: boolean }[],
    label: string,
  ): Partial<Record<K, number>> | null {
    const headers = headerRow.map((h) => clean(h).toLowerCase());
    const claimed = new Set<number>();
    const map: Partial<Record<K, number>> = {};
    const missing: string[] = [];

    for (const { key, match, required } of patterns) {
      const idx = headers.findIndex((h, i) => !claimed.has(i) && match.test(h));
      if (idx === -1) {
        if (required) missing.push(key);
        continue;
      }
      claimed.add(idx);
      map[key] = idx;
    }

    if (missing.length) {
      this.logger.error(
        `${label}: missing required columns: ${missing.join(', ')}. ` +
          `Headers found: [${headers.join(', ')}]`,
      );
      return null;
    }
    return map;
  }

  async fetchPieces(): Promise<ParsedPiece[]> {
    const sheetId = process.env.CF_SHEET_ID;
    const tabName = process.env.CF_TAB_NAME || 'Sheet1';

    if (!sheetId) {
      this.logger.warn('CF_SHEET_ID not configured, skipping Critical Flow sync');
      return [];
    }

    try {
      const sheets = google.sheets({ version: 'v4', auth: this.getAuth() });
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${tabName}'!A:AF`,
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'SERIAL_NUMBER',
      });

      const rows = res.data.values;
      if (!rows || rows.length < 2) return [];

      const col = this.matchHeaders(rows[0], PIECE_PATTERNS, 'Critical Flow sheet');
      if (!col) {
        this.logger.error('Critical Flow sheet: aborting sync — header match failed');
        return [];
      }

      const parsed: ParsedPiece[] = [];
      let skipped = 0;
      for (const row of rows.slice(1)) {
        const p = this.parsePiece(row, col);
        if (p) parsed.push(p);
        else skipped++;
      }
      if (skipped) this.logger.warn(`Critical Flow sheet: skipped ${skipped} invalid rows`);
      return parsed;
    } catch (error: any) {
      this.logger.error(`Failed to fetch Critical Flow sheet: ${error.message}`);
      throw error;
    }
  }

  async fetchRoster(): Promise<ParsedRosterPerson[]> {
    const sheetId = process.env.CF_SHEET_ID;
    const tabName = process.env.CF_ROSTER_TAB_NAME || 'Roster';
    if (!sheetId) return [];

    try {
      const sheets = google.sheets({ version: 'v4', auth: this.getAuth() });
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${tabName}'!A:J`,
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'SERIAL_NUMBER',
      });

      const rows = res.data.values;
      if (!rows || rows.length < 2) return [];

      const col = this.matchHeaders(rows[0], ROSTER_PATTERNS, 'Critical Flow roster');
      if (!col) return [];

      const text = (row: any[], key: RosterKey): string => {
        const i = col[key];
        return i === undefined ? '' : clean(row[i]);
      };

      const parsed: ParsedRosterPerson[] = [];
      for (const row of rows.slice(1)) {
        const id = text(row, 'id');
        const name = text(row, 'name');
        if (!id || !name) continue;
        const kind = text(row, 'kind').toLowerCase();
        if (kind && kind !== 'roster') continue;

        const role = text(row, 'role');
        parsed.push({
          id,
          division: normalizeDivision(text(row, 'division')),
          name: normalizePerson(name),
          role,
          roleGroup: classifyRole(role),
          weekoff: text(row, 'weekoff'),
          shift: text(row, 'shift'),
          email: text(row, 'email'),
          dailyTarget: parseNumber(
            col.target === undefined ? null : row[col.target],
          ),
          rawHash: computeRowHash(row),
        });
      }
      return parsed;
    } catch (error: any) {
      // Leave the existing roster in place rather than wiping it on a bad fetch.
      this.logger.error(`Failed to fetch Critical Flow roster: ${error.message}`);
      return [];
    }
  }

  private parsePiece(
    row: any[],
    col: Partial<Record<PieceKey, number>>,
  ): ParsedPiece | null {
    const raw = (key: PieceKey): any => {
      const i = col[key];
      return i === undefined ? undefined : row[i];
    };
    const text = (key: PieceKey): string => clean(raw(key));

    const id = text('id');
    if (!id) return null;
    const kind = text('kind').toLowerCase();
    if (kind && kind !== 'content') return null;

    const title = text('title');
    const allottedAt = parseDateTime(raw('allottedAt'));
    const submittedAt = parseDateTime(raw('submittedAt'));
    const editorAt = parseDateTime(raw('editorAt'));
    const editorAt2 = parseDateTime(raw('editorAt2'));
    const liveAt = parseDateTime(raw('liveAt'));
    const publishedDate = parseDateOnly(raw('publishedDate'));

    // Anchor every piece to the day it entered the pipeline, falling forward
    // only when the allotment stamp is missing.
    const anchor = allottedAt || submittedAt || editorAt || liveAt || null;
    const date = toDateOnly(anchor) ?? publishedDate;

    const parsed: ParsedPiece = {
      id,
      uniquePieceId: text('uniquePieceId'),
      division: normalizeDivision(text('division')),
      month: text('month'),
      writer: normalizePerson(text('writer')),
      editor: normalizePerson(text('editor')),
      editor2: clean(text('editor2')),
      allottedBy: normalizePerson(text('allottedBy')),
      articleType: normalizeArticleType(text('articleType')),
      yahoo: parseYahoo(raw('yahoo')),
      editorialStatus: normalizeStatus(text('editorialStatus')),
      editorialStatus2: normalizeStatus(text('editorialStatus2')),
      sbReason: normalizeSbReason(text('sbReason')),
      wpStatus: clean(text('wpStatus')),
      allottedAt,
      submittedAt,
      submittedEst: parseDateTime(raw('submittedEst')),
      editorAt,
      editorAt2,
      liveAt,
      wpCheckedAt: parseDateTime(raw('wpCheckedAt')),
      publishedDate,
      date,
      tatHours: parseNumber(raw('tatHours')),
      sbHours: parseNumber(raw('sbHours')),
      title,
      titleNorm: normalizeTitleKey(title),
      source: text('source'),
      stagingLink: text('stagingLink'),
      writerComments: text('writerComments'),
      editorComment: text('editorComment'),
      editorComment2: text('editorComment2'),
      articleMap: text('articleMap'),
      plagReport: text('plagReport'),
      rawHash: computeRowHash(row),
    };

    return isValidPiece(parsed) ? parsed : null;
  }
}
