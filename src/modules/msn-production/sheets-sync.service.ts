import { Injectable, Logger } from '@nestjs/common';
import { google } from 'googleapis';
import {
  ParsedPiece,
  ParsedRosterPerson,
  ParsedModerationRow,
} from './types';
import {
  normalizeFeed,
  normalizeWriter,
  normalizeEditor,
  normalizeAllotter,
  normalizeStatus,
  normalizeContentType,
  normalizeCategory,
  parseSlides,
  parseDateTime,
  reconcileTimestamps,
  toDateOnly,
  computeRowHash,
  normalizeTitleKey,
  isValidPiece,
} from './normalization';

// ── Header matching helpers ──

/** Canonical column keys we need from the integrated sheet. */
type PieceColumnKey =
  | 'id'
  | 'uniquePieceId'
  | 'category'
  | 'feed'
  | 'allottedAt'
  | 'allottedBy'
  | 'writer'
  | 'title'
  | 'primarySource'
  | 'featuredImage'
  | 'slides'
  | 'contentType'
  | 'pickedBy'
  | 'pickedAt'
  | 'sourcesUsed'
  | 'comments'
  | 'stagingLink'
  | 'submittedAt'
  | 'editor'
  | 'editorialStatus'
  | 'verifyStart'
  | 'verifyEnd'
  | 'feedback'
  | 'publishingStatus'
  | 'publishedAt'
  | 'kind';

type ColumnMap = Partial<Record<PieceColumnKey, number>>;

interface ColumnPattern {
  key: PieceColumnKey;
  match: RegExp;
  required?: boolean;
}

/**
 * Patterns are matched in order; each consumes the FIRST not-yet-claimed
 * header that matches. Order matters where headers overlap — e.g. the manual
 * "Publishing Time" vs the automatic "Publishing Time (Auto)", so the latter
 * carries an explicit `(auto)` anchor.
 */
const PIECE_HEADER_PATTERNS: ColumnPattern[] = [
  { key: 'id', match: /^id$/i, required: true },
  { key: 'uniquePieceId', match: /^unique\s*piece\s*id$/i },
  { key: 'category', match: /^sport\s*category$|^category$/i },
  { key: 'feed', match: /^feed$/i },
  { key: 'allottedAt', match: /^date\s*&?\s*time/i },
  { key: 'allottedBy', match: /^allot(t)?ed\s*by$/i },
  { key: 'writer', match: /^writer$/i },
  { key: 'title', match: /^title$/i },
  { key: 'primarySource', match: /^primary\s*source$/i },
  { key: 'featuredImage', match: /^featured\s*image$/i },
  { key: 'slides', match: /^(no\.?\s*of\s*slides|number\s*of\s*slides|slides)$/i },
  { key: 'contentType', match: /^type\s*\/?\s*category$|^type$/i },
  { key: 'pickedBy', match: /^picked\s*by$/i },
  { key: 'pickedAt', match: /^picked\s*at/i },
  { key: 'sourcesUsed', match: /^sources?\s*used$/i },
  { key: 'stagingLink', match: /^staging\s*link$/i },
  { key: 'submittedAt', match: /^submitted/i },
  { key: 'editor', match: /^editor$/i },
  { key: 'editorialStatus', match: /^editorial\s*status$/i },
  { key: 'verifyStart', match: /^ver[iy]f?ying\s*start/i },
  { key: 'verifyEnd', match: /^ver[iy]f?ying\s*end/i },
  { key: 'feedback', match: /^feedback$/i },
  { key: 'publishingStatus', match: /^publishing\s*status$/i },
  { key: 'publishedAt', match: /^publishing\s*time\s*\(auto\)/i },
  { key: 'kind', match: /^__kind$/i },
  // "Comments" is matched last so "Comments/TS" doesn't steal the plain one.
  { key: 'comments', match: /^comments(\s*\/\s*ts)?$/i },
];

// ── Roster tab ──

type RosterColumnKey = 'id' | 'division' | 'feed' | 'name' | 'role' | 'weekoff' | 'kind';

const ROSTER_HEADER_PATTERNS: { key: RosterColumnKey; match: RegExp; required?: boolean }[] = [
  { key: 'id', match: /^id$/i, required: true },
  { key: 'division', match: /^sport\s*category$|^division$|^category$/i },
  { key: 'feed', match: /^feed$/i },
  { key: 'name', match: /^name$/i, required: true },
  { key: 'role', match: /^role$/i },
  { key: 'weekoff', match: /^week\s*-?\s*off$/i },
  { key: 'kind', match: /^__kind$/i },
];

// ── Moderation log sheet (external moderation tool) ──

type ModerationColumnKey =
  | 'date'
  | 'title'
  | 'user'
  | 'feed'
  | 'category'
  | 'riskRating'
  | 'overallResult'
  | 'reason'
  | 'tbScore'
  | 'legalScore'
  | 'feedScore'
  | 'subjectiveScore';

const MODERATION_HEADER_PATTERNS: {
  key: ModerationColumnKey;
  match: RegExp;
  required?: boolean;
}[] = [
  { key: 'date', match: /^date$/i, required: true },
  { key: 'title', match: /^title$/i, required: true },
  { key: 'user', match: /^user$|^checked\s*by$/i },
  { key: 'feed', match: /^feed$/i },
  { key: 'category', match: /^category$/i },
  { key: 'riskRating', match: /^risk\s*rating$/i },
  { key: 'overallResult', match: /^overall\s*result$/i },
  { key: 'reason', match: /^reason$/i },
  { key: 'tbScore', match: /^tb\s*score$/i },
  { key: 'legalScore', match: /^legal\s*score$/i },
  { key: 'feedScore', match: /^feed\s*score$/i },
  { key: 'subjectiveScore', match: /^subjective\s*score$/i },
];

@Injectable()
export class SheetsSyncService {
  private readonly logger = new Logger(SheetsSyncService.name);

  private getAuth() {
    return new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  }

  /**
   * Build canonical-key → column-index map. Each pattern claims the first
   * unclaimed matching header. Aborts (returns null) if a required column
   * is missing.
   */
  private matchHeaders(headerRow: any[]): ColumnMap | null {
    const headers = headerRow.map(
      (h) => h?.toString()?.trim()?.toLowerCase() ?? '',
    );
    const claimed = new Set<number>();
    const map: ColumnMap = {};
    const missingRequired: string[] = [];

    for (const { key, match, required } of PIECE_HEADER_PATTERNS) {
      const idx = headers.findIndex((h, i) => !claimed.has(i) && match.test(h));
      if (idx === -1) {
        if (required) missingRequired.push(key);
        continue;
      }
      claimed.add(idx);
      map[key] = idx;
    }

    if (missingRequired.length > 0) {
      this.logger.error(
        `Integrated sheet: missing required columns: ${missingRequired.join(
          ', ',
        )}. Headers found: [${headers.join(', ')}]`,
      );
      return null;
    }

    this.logger.log(
      `Integrated sheet: column mapping resolved → ${JSON.stringify(map)}`,
    );
    return map;
  }

  async fetchPieces(): Promise<ParsedPiece[]> {
    const sheetId = process.env.MSN_SHEET_ID;
    const tabName = process.env.MSN_TAB_NAME || 'Sheet1';

    if (!sheetId) {
      this.logger.warn('MSN_SHEET_ID not configured, skipping sync');
      return [];
    }

    try {
      const auth = this.getAuth();
      const sheets = google.sheets({ version: 'v4', auth });

      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${tabName}'!A:AB`,
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'SERIAL_NUMBER',
      });

      const rows = res.data.values;
      if (!rows || rows.length < 2) return [];

      const colMap = this.matchHeaders(rows[0]);
      if (!colMap) {
        this.logger.error('Integrated sheet: aborting sync — header match failed');
        return [];
      }

      let skipped = 0;
      const parsed: ParsedPiece[] = [];

      for (const row of rows.slice(1)) {
        const result = this.parsePiece(row, colMap);
        if (result) parsed.push(result);
        else skipped++;
      }

      if (skipped > 0) {
        this.logger.warn(`Integrated sheet: skipped ${skipped} invalid rows`);
      }

      return parsed;
    } catch (error: any) {
      this.logger.error(`Failed to fetch integrated sheet: ${error.message}`);
      throw error;
    }
  }

  /** Fetch roster rows from the Roster tab (division / feed / role / weekoff). */
  async fetchRoster(): Promise<ParsedRosterPerson[]> {
    const sheetId = process.env.MSN_SHEET_ID;
    const tabName = process.env.MSN_ROSTER_TAB_NAME || 'Roster';

    if (!sheetId) return [];

    try {
      const auth = this.getAuth();
      const sheets = google.sheets({ version: 'v4', auth });

      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${tabName}'!A:H`,
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'SERIAL_NUMBER',
      });

      const rows = res.data.values;
      if (!rows || rows.length < 2) return [];

      const headers = rows[0].map(
        (h: any) => h?.toString()?.trim()?.toLowerCase() ?? '',
      );
      const claimed = new Set<number>();
      const col: Partial<Record<RosterColumnKey, number>> = {};
      for (const { key, match, required } of ROSTER_HEADER_PATTERNS) {
        const idx = headers.findIndex(
          (h: string, i: number) => !claimed.has(i) && match.test(h),
        );
        if (idx === -1) {
          if (required) {
            this.logger.error(`Roster tab: missing required column "${key}"`);
            return [];
          }
          continue;
        }
        claimed.add(idx);
        col[key] = idx;
      }

      const text = (row: any[], key: RosterColumnKey): string => {
        const idx = col[key];
        const v = idx === undefined ? undefined : row[idx];
        return v == null ? '' : v.toString().trim();
      };

      const parsed: ParsedRosterPerson[] = [];
      for (const row of rows.slice(1)) {
        const id = text(row, 'id');
        const name = text(row, 'name');
        if (!id || !name) continue;
        const kind = text(row, 'kind').toLowerCase();
        if (kind && kind !== 'roster') continue;

        parsed.push({
          id,
          division: text(row, 'division') || 'Unknown',
          feed: text(row, 'feed') || 'Unknown',
          name,
          role: text(row, 'role'),
          weekoff: text(row, 'weekoff'),
          rawHash: computeRowHash(row),
        });
      }

      return parsed;
    } catch (error: any) {
      this.logger.error(`Failed to fetch roster tab: ${error.message}`);
      return [];
    }
  }

  /**
   * Fetch moderation check rows from the external moderation tool's log
   * sheet. Failures return an empty array so the existing data is preserved.
   */
  async fetchModeration(): Promise<ParsedModerationRow[]> {
    const sheetId = process.env.MSN_MODERATION_SHEET_ID;
    const tabName = process.env.MSN_MODERATION_TAB_NAME || 'Sheet1';

    if (!sheetId) {
      this.logger.warn('MSN_MODERATION_SHEET_ID not configured, skipping moderation sync');
      return [];
    }

    try {
      const auth = this.getAuth();
      const sheets = google.sheets({ version: 'v4', auth });

      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${tabName}'!A:T`,
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'SERIAL_NUMBER',
      });

      const rows = res.data.values;
      if (!rows || rows.length < 2) return [];

      const headers = rows[0].map(
        (h: any) => h?.toString()?.trim()?.toLowerCase() ?? '',
      );
      const claimed = new Set<number>();
      const col: Partial<Record<ModerationColumnKey, number>> = {};
      for (const { key, match, required } of MODERATION_HEADER_PATTERNS) {
        const idx = headers.findIndex(
          (h: string, i: number) => !claimed.has(i) && match.test(h),
        );
        if (idx === -1) {
          if (required) {
            this.logger.error(`Moderation sheet: missing required column "${key}"`);
            return [];
          }
          continue;
        }
        claimed.add(idx);
        col[key] = idx;
      }

      const text = (row: any[], key: ModerationColumnKey): string => {
        const idx = col[key];
        const v = idx === undefined ? undefined : row[idx];
        return v == null ? '' : v.toString().trim();
      };

      const parsed = new Map<string, ParsedModerationRow>();
      let skipped = 0;
      for (const row of rows.slice(1)) {
        // Some rows carry multi-KB junk in the title cell; cap defensively.
        const title = text(row, 'title').slice(0, 500);
        const rawDate = text(row, 'date');
        if (!title || !rawDate) {
          skipped++;
          continue;
        }

        const rawRisk = text(row, 'riskRating');
        const risk = rawRisk === '' ? NaN : Number(rawRisk);
        const rawResult =
          col.overallResult === undefined ? undefined : row[col.overallResult];

        const entry: ParsedModerationRow = {
          // Stable identity: same timestamp + title + user = same check.
          id: computeRowHash([rawDate, title, text(row, 'user')]),
          checkedAt: parseDateTime(
            col.date === undefined ? undefined : row[col.date],
          ),
          title,
          titleNorm: normalizeTitleKey(title),
          checkedBy: text(row, 'user') || 'Unknown',
          feed: text(row, 'feed') || 'Unknown',
          category: text(row, 'category') || 'Unknown',
          riskRating: isNaN(risk) ? null : Math.round(risk),
          overallResult:
            rawResult === true ||
            String(rawResult ?? '').trim().toLowerCase() === 'true',
          reason: text(row, 'reason'),
          tbScore: text(row, 'tbScore').toUpperCase(),
          legalScore: text(row, 'legalScore').toUpperCase(),
          feedScore: text(row, 'feedScore').toUpperCase(),
          subjectiveScore: text(row, 'subjectiveScore').toUpperCase(),
          rawHash: computeRowHash(row.slice(0, 16)),
        };
        parsed.set(entry.id, entry); // dedupes identical re-runs
      }

      if (skipped > 0) {
        this.logger.warn(`Moderation sheet: skipped ${skipped} rows without title/date`);
      }

      return [...parsed.values()];
    } catch (error: any) {
      this.logger.error(`Failed to fetch moderation sheet: ${error.message}`);
      return [];
    }
  }

  private cell(row: any[], col: ColumnMap, key: PieceColumnKey): any {
    const idx = col[key];
    return idx === undefined ? undefined : row[idx];
  }

  private text(row: any[], col: ColumnMap, key: PieceColumnKey): string {
    const v = this.cell(row, col, key);
    return v == null ? '' : v.toString().trim();
  }

  private parsePiece(row: any[], col: ColumnMap): ParsedPiece | null {
    const id = this.text(row, col, 'id');
    if (!id) return null;

    // The integrated sheet tags content rows with __kind='content'; skip any
    // other kind (e.g. roster rows) that might appear on this tab.
    const kind = this.text(row, col, 'kind').toLowerCase();
    if (kind && kind !== 'content') return null;

    let contentType = normalizeContentType(this.text(row, col, 'contentType'));
    let slides = parseSlides(this.cell(row, col, 'slides'));

    // Resolve every piece to a canonical type so downstream per-type breakdowns
    // stay exhaustive (articles + slideshows === total). The source frequently
    // leaves Type/Category blank, or types a non-standard value into it (a
    // feed/tour name, a format label, a stray note); such a cell is classified
    // by slide count — a genuinely multi-slide piece is a slideshow, everything
    // else an article.
    if (
      contentType !== 'Article' &&
      contentType !== 'Slideshow' &&
      contentType !== 'SS Automation'
    ) {
      contentType = slides !== null && slides > 1 ? 'Slideshow' : 'Article';
    }
    // Articles are single-page. Writers routinely leave No-of-Slides blank on
    // them (there is nothing to count), which then reads as 0/"missing"
    // downstream — default it to 1 so an article always tallies as one slide.
    if (contentType === 'Article') {
      slides = 1;
    }
    // A slideshow with a 0 slide count simply hasn't had it filled in yet — keep
    // it null rather than tallying a zero.
    if (
      (contentType === 'Slideshow' || contentType === 'SS Automation') &&
      slides === 0
    ) {
      slides = null;
    }

    // Parse in lifecycle order, then repair DD/MM↔MM/DD encoding swaps the
    // source sheet introduces (some stamps otherwise land in the future).
    const [
      allottedAt,
      pickedAt,
      submittedAt,
      verifyStart,
      verifyEnd,
      publishedAt,
    ] = reconcileTimestamps([
      parseDateTime(this.cell(row, col, 'allottedAt')),
      parseDateTime(this.cell(row, col, 'pickedAt')),
      parseDateTime(this.cell(row, col, 'submittedAt')),
      parseDateTime(this.cell(row, col, 'verifyStart')),
      parseDateTime(this.cell(row, col, 'verifyEnd')),
      parseDateTime(this.cell(row, col, 'publishedAt')),
    ]);

    // Production date = allotment date, falling back through the lifecycle.
    const dateAnchor =
      allottedAt || pickedAt || submittedAt || publishedAt || null;

    const parsed: ParsedPiece = {
      id,
      uniquePieceId: this.text(row, col, 'uniquePieceId'),
      category: normalizeCategory(this.text(row, col, 'category')),
      feed: normalizeFeed(this.text(row, col, 'feed')),
      writer: normalizeWriter(this.text(row, col, 'writer')),
      editor: normalizeEditor(this.text(row, col, 'editor')),
      allottedBy: normalizeAllotter(this.text(row, col, 'allottedBy')),
      contentType,
      publishingStatus: normalizeStatus(this.text(row, col, 'publishingStatus')),
      editorialStatus: normalizeStatus(this.text(row, col, 'editorialStatus')),
      slides,
      allottedAt,
      pickedAt,
      submittedAt,
      verifyStart,
      verifyEnd,
      publishedAt,
      date: toDateOnly(dateAnchor),
      title: this.text(row, col, 'title'),
      pickedBy: this.text(row, col, 'pickedBy'),
      primarySource: this.text(row, col, 'primarySource'),
      sourcesUsed: this.text(row, col, 'sourcesUsed'),
      stagingLink: this.text(row, col, 'stagingLink'),
      featuredImage: this.text(row, col, 'featuredImage'),
      feedback: this.text(row, col, 'feedback'),
      comments: this.text(row, col, 'comments'),
      rawHash: computeRowHash(row),
    };

    if (!isValidPiece(parsed)) return null;

    return parsed;
  }
}
