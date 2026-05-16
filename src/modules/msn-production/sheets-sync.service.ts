import { Injectable, Logger } from '@nestjs/common';
import { google } from 'googleapis';
import { ParsedSourceRow, ParsedAllotmentRow } from './types';
import {
  normalizeFeed,
  normalizeWriter,
  normalizeEditor,
  normalizeAllotter,
  normalizeStatus,
  normalizeContentType,
  parseSlides,
  parseSheetsDate,
  parseSheetsTimestamp,
  computeRowHash,
  isValidSourceRow,
  isValidAllotmentRow,
} from './normalization';

// ── Header matching helpers ──

/** Canonical column keys we need from each sheet */
type SourceColumnKey =
  | 'rowId'
  | 'date'
  | 'brand'
  | 'contentType'
  | 'feed'
  | 'writer'
  | 'editor'
  | 'status'
  | 'slides'
  | 'publishTimestamp'
  | 'title';

type AllotmentColumnKey =
  | 'allottedBy'
  | 'date'
  | 'brand'
  | 'feed'
  | 'writer'
  | 'contentType'
  | 'status'
  | 'slides'
  | 'title';

type ColumnMap<K extends string> = Record<K, number>;

/**
 * Build a map from canonical column key → column index by matching header
 * text against known patterns. Matching is case-insensitive and ignores
 * leading/trailing whitespace. Returns `null` if any required column is
 * missing, logging which ones were not found.
 */
function matchHeaders<K extends string>(
  headerRow: any[],
  patterns: { key: K; match: RegExp }[],
  logger: Logger,
  sheetLabel: string,
): ColumnMap<K> | null {
  const headers = headerRow.map(
    (h) => h?.toString()?.trim()?.toLowerCase() ?? '',
  );

  const map: Partial<ColumnMap<K>> = {};
  const missing: string[] = [];

  for (const { key, match } of patterns) {
    // Find the FIRST header that matches (avoids duplicate-column issues)
    const idx = headers.findIndex((h) => match.test(h));
    if (idx === -1) {
      missing.push(key);
    } else {
      (map as any)[key] = idx;
    }
  }

  if (missing.length > 0) {
    logger.error(
      `${sheetLabel}: could not locate columns: ${missing.join(', ')}. ` +
        `Headers found: [${headers.join(', ')}]`,
    );
    return null;
  }

  logger.log(`${sheetLabel}: column mapping resolved → ${JSON.stringify(map)}`);
  return map as ColumnMap<K>;
}

// ── Header patterns ──

const SOURCE_HEADER_PATTERNS: { key: SourceColumnKey; match: RegExp }[] = [
  { key: 'rowId', match: /^(row\s*id|sr\.?\s*no|s\.?\s*no|#|id)$/i },
  { key: 'date', match: /^date$/i },
  { key: 'brand', match: /^brand$/i },
  { key: 'contentType', match: /^(content\s*type|type)$/i },
  { key: 'feed', match: /^(feed|feed\s*\/\s*sub[- ]?category)$/i },
  { key: 'writer', match: /^writer$/i },
  { key: 'editor', match: /^editor$/i },
  { key: 'status', match: /^status$/i },
  {
    key: 'slides',
    match: /^(no\.?\s*of\s*slides|slides|number\s*of\s*slides)$/i,
  },
  {
    key: 'publishTimestamp',
    match: /^(publish\s*(time|timestamp)|published?\s*at|timestamp)$/i,
  },
  { key: 'title', match: /^title$/i },
];

const ALLOTMENT_HEADER_PATTERNS: {
  key: AllotmentColumnKey;
  match: RegExp;
}[] = [
  { key: 'allottedBy', match: /^allot(ted|ter)?\s*by$/i },
  { key: 'date', match: /^date$/i },
  { key: 'brand', match: /^brand$/i },
  { key: 'feed', match: /^(feed|feed\s*\/\s*sub[- ]?category)$/i },
  { key: 'writer', match: /^writer$/i },
  { key: 'contentType', match: /^(content\s*type|type)$/i },
  { key: 'status', match: /^status$/i },
  {
    key: 'slides',
    match: /^(no\.?\s*of\s*slides|slides|number\s*of\s*slides)$/i,
  },
  { key: 'title', match: /^title$/i },
];

@Injectable()
export class SheetsSyncService {
  private readonly logger = new Logger(SheetsSyncService.name);

  private getAuth() {
    return new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  }

  // ── Source sheet ──

  async fetchSourceSheet(): Promise<ParsedSourceRow[]> {
    const sheetId = process.env.MSN_SOURCE_SHEET_ID;
    const tabName = process.env.MSN_SOURCE_TAB_NAME || 'Sheet1';

    if (!sheetId) {
      this.logger.warn(
        'MSN_SOURCE_SHEET_ID not configured, skipping source sheet sync',
      );
      return [];
    }

    try {
      const auth = this.getAuth();
      const sheets = google.sheets({ version: 'v4', auth });

      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${tabName}'!A:Z`,
      });

      const rows = res.data.values;
      if (!rows || rows.length < 2) return [];

      // Dynamically resolve column positions from the header row
      const colMap = matchHeaders<SourceColumnKey>(
        rows[0],
        SOURCE_HEADER_PATTERNS,
        this.logger,
        'Source sheet',
      );
      if (!colMap) {
        this.logger.error(
          'Source sheet: aborting sync — column mapping failed',
        );
        return [];
      }

      let skipped = 0;
      const parsed: ParsedSourceRow[] = [];

      for (const row of rows.slice(1)) {
        const result = this.parseSourceRow(row, colMap);
        if (result) {
          parsed.push(result);
        } else {
          skipped++;
        }
      }

      if (skipped > 0) {
        this.logger.warn(
          `Source sheet: skipped ${skipped} invalid/incomplete rows`,
        );
      }

      return parsed;
    } catch (error: any) {
      this.logger.error(`Failed to fetch source sheet: ${error.message}`);
      throw error;
    }
  }

  // ── Allotment sheet ──

  async fetchAllotmentSheet(): Promise<ParsedAllotmentRow[]> {
    const sheetId = process.env.MSN_ALLOTMENT_SHEET_ID;
    const tabName =
      process.env.MSN_ALLOTMENT_TAB_NAME || 'Master Allotment Sheet DB';

    if (!sheetId) {
      this.logger.warn(
        'MSN_ALLOTMENT_SHEET_ID not configured, skipping allotment sheet sync',
      );
      return [];
    }

    try {
      const auth = this.getAuth();
      const sheets = google.sheets({ version: 'v4', auth });

      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${tabName}'!A:Z`,
      });

      const rows = res.data.values;
      if (!rows || rows.length < 2) return [];

      // Dynamically resolve column positions from the header row
      const colMap = matchHeaders<AllotmentColumnKey>(
        rows[0],
        ALLOTMENT_HEADER_PATTERNS,
        this.logger,
        'Allotment sheet',
      );
      if (!colMap) {
        this.logger.error(
          'Allotment sheet: aborting sync — column mapping failed',
        );
        return [];
      }

      let skipped = 0;
      const parsed: ParsedAllotmentRow[] = [];

      for (const row of rows.slice(1)) {
        const result = this.parseAllotmentRow(row, colMap);
        if (result) {
          parsed.push(result);
        } else {
          skipped++;
        }
      }

      if (skipped > 0) {
        this.logger.warn(
          `Allotment sheet: skipped ${skipped} invalid/incomplete rows`,
        );
      }

      return parsed;
    } catch (error: any) {
      this.logger.error(`Failed to fetch allotment sheet: ${error.message}`);
      throw error;
    }
  }

  // ── Row parsers (now use dynamic column maps) ──

  private parseSourceRow(
    row: any[],
    col: ColumnMap<SourceColumnKey>,
  ): ParsedSourceRow | null {
    const rowId = row[col.rowId]?.toString()?.trim();
    if (!rowId) return null;

    const contentType = normalizeContentType(row[col.contentType]?.toString());
    let numberOfSlides = parseSlides(row[col.slides]);

    // Articles are always 1 piece regardless of slide count
    if (contentType === 'Article') {
      numberOfSlides = 1;
    }
    // Slideshows with 0 slides is a data entry error — treat as unknown
    if (
      (contentType === 'Slideshow' || contentType === 'SS Automation') &&
      numberOfSlides === 0
    ) {
      numberOfSlides = null;
    }

    const parsed = {
      rowId,
      date: parseSheetsDate(row[col.date]),
      brand: row[col.brand]?.toString()?.trim() || 'Unknown',
      contentType,
      feed: normalizeFeed(row[col.feed]?.toString()),
      writer: normalizeWriter(row[col.writer]?.toString()),
      editor: normalizeEditor(row[col.editor]?.toString()),
      status: normalizeStatus(row[col.status]?.toString()),
      numberOfSlides,
      publishTimestamp: parseSheetsTimestamp(row[col.publishTimestamp]),
      title: row[col.title]?.toString()?.trim() || '',
      rawHash: computeRowHash(row),
    };

    if (!isValidSourceRow(parsed)) return null;

    return parsed;
  }

  private parseAllotmentRow(
    row: any[],
    col: ColumnMap<AllotmentColumnKey>,
  ): ParsedAllotmentRow | null {
    const brand = row[col.brand]?.toString()?.trim();
    if (!brand) return null;

    const contentType = normalizeContentType(row[col.contentType]?.toString());
    let slides = parseSlides(row[col.slides]);

    if (contentType === 'Article') {
      slides = 1;
    }
    if (
      (contentType === 'Slideshow' || contentType === 'SS Automation') &&
      slides === 0
    ) {
      slides = null;
    }

    const parsed = {
      allottedBy: normalizeAllotter(row[col.allottedBy]?.toString()),
      date: parseSheetsDate(row[col.date]),
      brand,
      feed: normalizeFeed(row[col.feed]?.toString()),
      writer: normalizeWriter(row[col.writer]?.toString()),
      contentType,
      status: normalizeStatus(row[col.status]?.toString()),
      slides,
      title: row[col.title]?.toString()?.trim() || '',
      rawHash: computeRowHash(row),
    };

    if (!isValidAllotmentRow(parsed)) return null;

    return parsed;
  }
}
