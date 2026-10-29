import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { google } from 'googleapis';
import { clean, normalizeStatus, parseDateTime } from '../production/normalization';

/** The Basketballnews.com workbook — a Yahoo-only desk with a sheet of its own. */
const DEFAULT_SHEET_ID = '1uonCiv7IC0WasF1K9k-So6Fu9VKqsuVcCyjWV62fkPw';

const MONTH_TAB =
  /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}(\s*\(.*\))?$/i;

type Key =
  | 'writer' | 'allottedAt' | 'stagingLink' | 'title' | 'submittedAt'
  | 'editor' | 'status' | 'editorAt'
  | 'editor2' | 'status2' | 'editorAt2'
  | 'editor3' | 'status3' | 'editorAt3'
  | 'liveAt' | 'wpStatus';

/**
 * The workbook follows the Critical Flow template with a third editorial pass
 * added, and repeats "Editor", "Editorial Status" and "Timestamp (Automated)"
 * once per pass. Each pattern claims the first unclaimed match, so the passes
 * land in order. "Reason for SB" is not read: it holds notes ("PR published",
 * "Sch 4 pm") as often as reasons.
 */
const PATTERNS: { key: Key; match: RegExp }[] = [
  // May's header for this column is a bare "w".
  { key: 'writer', match: /^(writer|w)$/ },
  { key: 'allottedAt', match: /^date\s*\(auto/ },
  { key: 'stagingLink', match: /staging\s*link$/ },
  { key: 'title', match: /^title$/ },
  { key: 'submittedAt', match: /^submission\s*time/ },
  ...([['editor', 'status', 'editorAt'], ['editor2', 'status2', 'editorAt2'], ['editor3', 'status3', 'editorAt3']] as Key[][]).flatMap(
    ([editor, status, at]) => [
      { key: editor, match: /^editor$/ },
      { key: status, match: /^editorial\s*status$/ },
      { key: at, match: /^timestamp\s*\(auto/ },
    ],
  ),
  { key: 'liveAt', match: /^actual\s*live\s*time/ },
  { key: 'wpStatus', match: /^wp\s*status$/ },
];

export interface BbNewsPiece {
  /** Month tab and sheet row, e.g. "October 2026!12". */
  ref: string;
  title: string;
  writer: string;
  /** The editor of the last pass that names one. */
  editor: string;
  allottedAt: Date | null;
  submittedAt: Date | null;
  hasStagingLink: boolean;
  /** First editorial pass, then the passes after a send-back. */
  passes: { status: string; at: Date | null }[];
  /** Signed off as "Completed" in the final-verification block. */
  finalVerifiedAt: Date | null;
  liveAt: Date | null;
  wpStatus: string;
}

export interface BbNewsRead {
  pieces: BbNewsPiece[];
  readAt: Date | null;
  /** Why the last read failed; the previous pieces are kept meanwhile. */
  error: string | null;
}

/**
 * Some September allotment dates were typed as text, day first ("13/09/2026",
 * "1/10/2026"). The generic parser would read "1/10/2026" as January 10th.
 */
function parseCell(raw: any): Date | null {
  const m = typeof raw === 'string' ? /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(raw) : null;
  if (!m) return parseDateTime(raw);
  const [, d, mo, y] = m;
  return parseDateTime(`${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`);
}

/**
 * Reads the BB News workbook straight from Sheets. It is not one of the n8n
 * aggregate's sources (its layout differs) and only the Sheet Roundup counts
 * it, so it is held in memory rather than in a table: re-read every 10
 * minutes, and on first use after a restart.
 */
@Injectable()
export class BbNewsService implements OnModuleInit {
  private readonly logger = new Logger(BbNewsService.name);
  private state: BbNewsRead = { pieces: [], readAt: null, error: null };
  private inFlight: Promise<void> | null = null;

  onModuleInit() {
    void this.refresh();
  }

  @Cron('*/10 * * * *')
  refresh(): Promise<void> {
    this.inFlight ??= this.load().finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  async read(): Promise<BbNewsRead> {
    if (!this.state.readAt && !this.state.error) await this.refresh();
    return this.state;
  }

  private async load() {
    const spreadsheetId = process.env.BB_NEWS_SHEET_ID || DEFAULT_SHEET_ID;
    try {
      const sheets = google.sheets({
        version: 'v4',
        auth: new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] }),
      });
      const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(title)' });
      const tabs = (meta.data.sheets ?? [])
        .map((s) => String(s.properties?.title ?? ''))
        .filter((t) => MONTH_TAB.test(t.trim()));
      if (!tabs.length) throw new Error('no "<Month> <Year>" tabs found');

      const res = await sheets.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges: tabs.map((t) => `'${t.replace(/'/g, "''")}'!A1:AZ5000`),
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'SERIAL_NUMBER',
      });
      const pieces = (res.data.valueRanges ?? []).flatMap((vr, i) => this.parseTab(tabs[i], vr.values ?? []));
      this.state = { pieces, readAt: new Date(), error: null };
      this.logger.log(`BB News: ${pieces.length} pieces from ${tabs.length} month tabs`);
    } catch (e: any) {
      this.state = { ...this.state, error: e?.message || String(e) };
      this.logger.error(`BB News read failed: ${this.state.error}`);
    }
  }

  private parseTab(tab: string, rows: any[][]): BbNewsPiece[] {
    const headers = (rows[0] ?? []).map((h) => clean(h).toLowerCase());
    const col: Partial<Record<Key, number>> = {};
    const claimed = new Set<number>();
    for (const { key, match } of PATTERNS) {
      const i = headers.findIndex((h, c) => !claimed.has(c) && match.test(h));
      if (i === -1) continue;
      claimed.add(i);
      col[key] = i;
    }
    if (col.title === undefined) {
      this.logger.warn(`BB News: "${tab}" has no Title column, skipped`);
      return [];
    }
    // The final-verification block ("TAT" … "Date") sits one column left of its
    // headers, so its cells are told apart by what they hold, not where.
    const blockStart = headers.indexOf('tat');
    const blockEnd = col.liveAt ?? headers.length;
    const finalVerifiedAt = (row: any[]): Date | null => {
      if (blockStart < 0) return null;
      const cells = row.slice(blockStart, blockEnd);
      if (!cells.some((c) => /^completed$/i.test(clean(c)))) return null;
      const stamp = cells.find((c) => typeof c === 'number' && c > 30000);
      return stamp === undefined ? null : parseCell(stamp);
    };

    const out: BbNewsPiece[] = [];
    rows.slice(1).forEach((row, i) => {
      const raw = (k: Key) => (col[k] === undefined ? undefined : row[col[k]!]);
      const text = (k: Key) => clean(raw(k));
      const title = text('title');
      if (!title) return;
      const passes = (
        [
          ['status', 'editorAt', 'editor'],
          ['status2', 'editorAt2', 'editor2'],
          ['status3', 'editorAt3', 'editor3'],
        ] as const
      ).map(([s, at, ed]) => ({ status: normalizeStatus(text(s)), at: parseCell(raw(at)), editor: text(ed) }));
      out.push({
        ref: `${tab}!${i + 2}`,
        title,
        writer: text('writer'),
        editor: [...passes].reverse().find((p) => p.editor)?.editor ?? '',
        allottedAt: parseCell(raw('allottedAt')),
        submittedAt: parseCell(raw('submittedAt')),
        hasStagingLink: !!text('stagingLink'),
        passes: passes.map(({ status, at }) => ({ status, at })),
        finalVerifiedAt: finalVerifiedAt(row),
        liveAt: parseCell(raw('liveAt')),
        wpStatus: text('wpStatus').toLowerCase(),
      });
    });
    return out;
  }
}
