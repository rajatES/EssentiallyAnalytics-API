import { Injectable, Logger } from '@nestjs/common';
import { google } from 'googleapis';
import { ParsedYpPiece, ParsedYpQuota } from './types';
import {
  clean,
  computeRowHash,
  isValidPiece,
  normalizeArticleType,
  normalizeDivision,
  normalizePerson,
  normalizeStatus,
  normalizeTitleKey,
  parseDateOnly,
  parseDateTime,
  parseNumber,
  toDateOnly,
} from '../production/normalization';

type PieceKey =
  | 'id' | 'uniquePieceId' | 'division' | 'month' | 'workDate' | 'allottedBy'
  | 'allottedAt' | 'writer' | 'articleType' | 'title' | 'source'
  | 'stagingLink' | 'submittedAt' | 'editor' | 'plagReport'
  | 'editorialStatus' | 'publishedAt' | 'enhancement' | 'editorComment'
  | 'writerComments' | 'liveAt' | 'wpStatus' | 'wpCheckedAt' | 'tatHours';

const PIECE_PATTERNS: { key: PieceKey; match: RegExp; required?: boolean }[] = [
  { key: 'id', match: /^id$/i, required: true },
  { key: 'uniquePieceId', match: /^unique\s*piece\s*id$/i },
  { key: 'division', match: /^division$/i, required: true },
  { key: 'month', match: /^month$/i },
  { key: 'workDate', match: /^work\s*date$/i },
  { key: 'allottedBy', match: /^allot(t)?ed\s*by$/i },
  { key: 'allottedAt', match: /^allot(t)?ed\s*at$/i },
  { key: 'writer', match: /^writer$/i },
  { key: 'articleType', match: /^article\s*type$/i },
  { key: 'title', match: /^title$/i, required: true },
  { key: 'source', match: /^source$/i },
  { key: 'stagingLink', match: /^staging\s*link$/i },
  { key: 'submittedAt', match: /^submitted\s*at$/i },
  { key: 'editor', match: /^editor$/i },
  { key: 'plagReport', match: /^plag\s*report$/i },
  { key: 'editorialStatus', match: /^editorial\s*status$/i },
  { key: 'publishedAt', match: /^published\s*at$/i },
  { key: 'enhancement', match: /^enhancement$/i },
  { key: 'editorComment', match: /^editor\s*comment$/i },
  { key: 'writerComments', match: /^writer\s*comments?$/i },
  { key: 'liveAt', match: /^live\s*at$/i },
  { key: 'wpStatus', match: /^wp\s*status$/i },
  { key: 'wpCheckedAt', match: /^wp\s*last\s*checked$/i },
  { key: 'tatHours', match: /^tat\s*hours$/i },
];

type QuotaKey = 'id' | 'division' | 'quota' | 'window' | 'poc';

const QUOTA_PATTERNS: { key: QuotaKey; match: RegExp; required?: boolean }[] = [
  { key: 'id', match: /^id$/i, required: true },
  { key: 'division', match: /^division$/i, required: true },
  { key: 'quota', match: /^quota$/i },
  { key: 'window', match: /^window$/i },
  { key: 'poc', match: /^poc$/i },
];

/**
 * One quota row can cover several content divisions — the sheet writes
 * "Tennis+Olympics" while the pieces record Tennis and Olympics separately.
 */
function expandDivisions(label: string): string[] {
  return label
    .split(/\s*[+/,&]\s*|\s+and\s+/i)
    .map((d) => normalizeDivision(d))
    .filter((d) => d && d !== 'Unknown');
}

@Injectable()
export class YpSheetsSyncService {
  private readonly logger = new Logger(YpSheetsSyncService.name);

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
    const headers = (headerRow || []).map((h) => clean(h).toLowerCase());
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

  private async read(range: string): Promise<any[][] | null> {
    const sheetId = process.env.YP_SHEET_ID;
    if (!sheetId) return null;
    const sheets = google.sheets({ version: 'v4', auth: this.getAuth() });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER',
    });
    return res.data.values ?? null;
  }

  async fetchPieces(): Promise<ParsedYpPiece[]> {
    if (!process.env.YP_SHEET_ID) {
      this.logger.warn('YP_SHEET_ID not configured, skipping Yahoo sync');
      return [];
    }
    const tab = process.env.YP_TAB_NAME || 'Sheet1';

    try {
      const rows = await this.read(`'${tab}'!A:X`);
      if (!rows || rows.length < 2) return [];

      const col = this.matchHeaders(rows[0], PIECE_PATTERNS, 'Yahoo sheet');
      if (!col) {
        this.logger.error('Yahoo sheet: aborting sync — header match failed');
        return [];
      }

      const parsed: ParsedYpPiece[] = [];
      let skipped = 0;
      for (const row of rows.slice(1)) {
        const p = this.parsePiece(row, col);
        if (p) parsed.push(p);
        else skipped++;
      }
      if (skipped) this.logger.warn(`Yahoo sheet: skipped ${skipped} invalid rows`);
      return parsed;
    } catch (error: any) {
      this.logger.error(`Failed to fetch Yahoo sheet: ${error.message}`);
      throw error;
    }
  }

  async fetchQuotas(): Promise<ParsedYpQuota[]> {
    const tab = process.env.YP_ROSTER_TAB_NAME || 'Roster';
    try {
      const rows = await this.read(`'${tab}'!A:L`);
      if (!rows || rows.length < 2) return [];

      const col = this.matchHeaders(rows[0], QUOTA_PATTERNS, 'Yahoo quotas');
      if (!col) return [];

      const text = (row: any[], key: QuotaKey): string => {
        const i = col[key];
        return i === undefined ? '' : clean(row[i]);
      };

      const parsed: ParsedYpQuota[] = [];
      for (const row of rows.slice(1)) {
        const id = text(row, 'id');
        const division = text(row, 'division');
        if (!id || !division) continue;
        parsed.push({
          id,
          division,
          divisions: expandDivisions(division),
          quota: parseNumber(col.quota === undefined ? null : row[col.quota]),
          window: text(row, 'window'),
          poc: text(row, 'poc'),
          rawHash: computeRowHash(row),
        });
      }
      return parsed;
    } catch (error: any) {
      // Leave the existing quotas in place rather than wiping them on a bad fetch.
      this.logger.error(`Failed to fetch Yahoo quotas: ${error.message}`);
      return [];
    }
  }

  private parsePiece(
    row: any[],
    col: Partial<Record<PieceKey, number>>,
  ): ParsedYpPiece | null {
    const raw = (key: PieceKey): any => {
      const i = col[key];
      return i === undefined ? undefined : row[i];
    };
    const text = (key: PieceKey): string => clean(raw(key));

    const id = text('id');
    if (!id) return null;

    const title = text('title');
    const allottedAt = parseDateTime(raw('allottedAt'));
    const submittedAt = parseDateTime(raw('submittedAt'));
    // One editorial pass that ends at publication, so the automated publishing
    // stamp is both the editorial timestamp and the publication date.
    const publishedAt = parseDateTime(raw('publishedAt'));
    const liveAt = parseDateTime(raw('liveAt'));

    const workDate = parseDateOnly(raw('workDate'));
    const anchor = allottedAt || submittedAt || publishedAt || liveAt || null;
    const date = workDate ?? toDateOnly(anchor);

    const parsed: ParsedYpPiece = {
      id,
      uniquePieceId: text('uniquePieceId'),
      division: normalizeDivision(text('division')),
      month: text('month'),
      writer: normalizePerson(text('writer')),
      editor: normalizePerson(text('editor')),
      allottedBy: normalizePerson(text('allottedBy')),
      articleType: normalizeArticleType(text('articleType')),
      enhancement: text('enhancement'),
      editorialStatus: normalizeStatus(text('editorialStatus')),
      wpStatus: text('wpStatus'),
      allottedAt,
      submittedAt,
      editorAt: publishedAt,
      liveAt,
      wpCheckedAt: parseDateTime(raw('wpCheckedAt')),
      publishedDate: toDateOnly(publishedAt) ?? toDateOnly(liveAt),
      date,
      tatHours: parseNumber(raw('tatHours')),
      title,
      titleNorm: normalizeTitleKey(title),
      source: text('source'),
      stagingLink: text('stagingLink'),
      writerComments: text('writerComments'),
      editorComment: text('editorComment'),
      plagReport: text('plagReport'),
      rawHash: computeRowHash(row),
    };

    return isValidPiece(parsed) ? parsed : null;
  }
}
