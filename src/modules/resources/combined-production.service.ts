import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CfPiece } from '../critical-flow/entities/cf-piece.entity';
import * as cfStages from '../critical-flow/stages';
import { YpPiece } from '../yahoo-production/entities/yp-piece.entity';
import * as ypStages from '../yahoo-production/stages';
import { activeDayCount, perDay } from '../production/analytics';
import { buildNameResolver } from '../production/name-resolver';
import { clean, normalizeTitleKey, toDateOnly } from '../production/normalization';
import { opsDayOf, shiftDate } from '../production/time';
import { ResPerson } from './entities/res-person.entity';
import { FLOAT_POOLS, canonicalDivision } from './divisions';

export interface Split {
  yahoo: number;
  nonYahoo: number;
  total: number;
}

export interface CombinedProductionResult {
  startDate: string | null;
  endDate: string | null;
  totals: { submitted: Split; published: Split };
  days: { date: string; published: Split }[];
  writers: {
    writer: string;
    division: string;
    submitted: Split;
    sentBack: number;
    /** Distinct days in the range they submitted on; null for the no-writer row. */
    daysWorked: number | null;
    /** Submitted per day worked. */
    perDay: number | null;
  }[];
  editors: {
    editor: string;
    division: string;
    published: Split;
    /** Distinct days in the range they cleared a counted piece on; null for the no-editor row. */
    daysWorked: number | null;
    /** Published per day worked. */
    perDay: number | null;
  }[];
  divisions: { division: string; submitted: Split; published: Split }[];
  notes: {
    /** CF pieces also tracked on the Yahoo sheet, all dates — each counted once, as Yahoo. */
    sharedWithYahoo: number;
    /** Pieces with no stamp to place them on any day, so outside every range. */
    undated: number;
  };
}

/** Articles written, edited and published in a range. */
export interface RoundupCounts {
  written: number;
  edited: number;
  published: number;
}

export interface SheetRoundupResult {
  startDate: string | null;
  endDate: string | null;
  total: RoundupCounts;
  yahoo: RoundupSide;
  nonYahoo: RoundupSide;
  days: { date: string; yahoo: RoundupCounts; nonYahoo: RoundupCounts }[];
  notes: {
    /** CF-sheet pieces with activity in the range that the Yahoo sheet also tracks, so counted under Yahoo. */
    sharedWithYahoo: number;
    /** Pieces with no stamp to place them on any day, so outside every range. */
    undated: number;
  };
}

export interface RoundupSide {
  totals: RoundupCounts;
  /** One row per source sheet; for Yahoo, one per division on its single sheet. */
  sheets: ({ sheet: string } & RoundupCounts)[];
}

interface Piece {
  yahoo: boolean;
  division: string;
  /** The Yahoo sheet's own Division cell; the CF sheet's division otherwise. */
  sheet: string;
  writer: string;
  editor: string;
  submittedDay: string | null;
  publishedDay: string | null;
  /** When the credited editor's pass ended — the day they worked on it. */
  editedAt: Date | null;
  /** Desk day of the last editorial pass, or null when it was never edited. */
  editedDay: string | null;
  sentBack: boolean;
  /** Submitted or published, yet nothing places it on a day. */
  undated: boolean;
}

/** A shared title shorter than this is too generic to prove two rows are one piece. */
const MIN_TITLE_KEY = 20;

const split = (): Split => ({ yahoo: 0, nonYahoo: 0, total: 0 });
const counts = (): RoundupCounts => ({ written: 0, edited: 0, published: 0 });

/**
 * The day a piece's editing counts on: its last pass, so a send-back is one
 * article edited, not two. An edit that ended in a scrap or a hold is not
 * counted; a piece that went live without an editor stamp falls back to its
 * publication date.
 */
function editedDayOf(
  lastPass: Date | null | undefined,
  outcome: { verified: boolean; published: boolean; killed: boolean; onHold: boolean },
  publishedDay: string | null,
): string | null {
  if (!outcome.published && (outcome.killed || outcome.onHold)) return null;
  if (lastPass) return opsDayOf(lastPass);
  return outcome.verified ? publishedDay : null;
}
const add = (s: Split, yahoo: boolean) => {
  if (yahoo) s.yahoo++;
  else s.nonYahoo++;
  s.total++;
};
const known = (n: string | null | undefined) => (n && n !== 'Unknown' ? n : '');

// Pieces the sheet credits to nobody still count toward the totals, so the
// people tables carry them as a row of their own and always add up — 300
// September CF publications had no editor named (Golf stopped filling it in).
export const NO_WRITER = 'No writer recorded';
export const NO_EDITOR = 'No editor recorded';

/**
 * Yahoo and Critical Flow production side by side, split the way the desk's
 * own Summary tabs split it: writers by what they submitted, editors and days
 * by what was published.
 *
 * The Yahoo sheet decides what counts as Yahoo. A CF piece marked for Yahoo is
 * usually tracked again on the Yahoo sheet under the same title (354 in
 * September); that pair is one article, counted once, as Yahoo, with the Yahoo
 * row's publisher credited. Everything else on the CF sheets is Non-Yahoo.
 *
 * Days: a submission counts on its desk day (IST, 00:00–03:59 rolled into the
 * previous night's shift); a publication on the date each sheet records it —
 * the Yahoo publishing stamp, the CF "Date EST" column.
 */
@Injectable()
export class CombinedProductionService {
  constructor(
    @InjectRepository(CfPiece) private readonly cfRepo: Repository<CfPiece>,
    @InjectRepository(YpPiece) private readonly ypRepo: Repository<YpPiece>,
    @InjectRepository(ResPerson) private readonly peopleRepo: Repository<ResPerson>,
  ) {}

  /**
   * Every piece on both sheets, each article once. CF rows the Yahoo sheet also
   * tracks come back separately as `twins` and are left out of `pieces`.
   */
  private async loadPieces(): Promise<{ pieces: Piece[]; twins: Piece[] }> {
    const [cf, yp] = await Promise.all([this.cfRepo.find(), this.ypRepo.find()]);

    const pieces: Piece[] = [];
    const twins: Piece[] = [];
    const yahooByTitle = new Map<string, YpPiece>();
    for (const y of yp) {
      const key = normalizeTitleKey(y.title);
      if (key.length >= MIN_TITLE_KEY && !yahooByTitle.has(key)) yahooByTitle.set(key, y);
    }

    const cfTwinWriter = new Map<YpPiece, string>();
    for (const p of cf) {
      const key = normalizeTitleKey(p.title);
      const twin = key.length >= MIN_TITLE_KEY ? yahooByTitle.get(key) : undefined;
      if (twin && known(p.writer)) cfTwinWriter.set(twin, p.writer);
      const stamp = p.submittedAt || p.editorAt;
      const published = cfStages.isPublished(p);
      const submittedDay = cfStages.isSubmitted(p) ? (stamp ? opsDayOf(stamp) : p.date) : null;
      const publishedDay = published
        ? p.publishedDate ?? toDateOnly(p.liveAt ?? p.editorAt2 ?? p.editorAt ?? null)
        : null;
      const secondPass = !!known(p.editor2);
      (twin ? twins : pieces).push({
        yahoo: false,
        division: p.division,
        sheet: p.division,
        writer: known(p.writer),
        // The pass that cleared the piece: the second editor after a send-back.
        editor: known(p.editor2) || known(p.editor),
        submittedDay,
        publishedDay,
        editedAt: (secondPass ? p.editorAt2 ?? p.editorAt : p.editorAt) ?? null,
        editedDay: editedDayOf(
          p.editorAt2 ?? p.editorAt,
          {
            verified: cfStages.isVerified(p),
            published,
            killed: cfStages.isKilled(p),
            onHold: cfStages.isOnHold(p),
          },
          publishedDay,
        ),
        sentBack: cfStages.isSentBack(p),
        undated: (cfStages.isSubmitted(p) && !submittedDay) || (published && !publishedDay),
      });
    }

    for (const y of yp) {
      const stamp = y.submittedAt || y.editorAt;
      const published = ypStages.isPublished(y);
      const submittedDay = ypStages.isSubmitted(y) ? (stamp ? opsDayOf(stamp) : y.date) : null;
      const publishedDay = published ? y.publishedDate ?? toDateOnly(y.liveAt ?? null) : null;
      pieces.push({
        yahoo: true,
        division: canonicalDivision(y.division).division,
        sheet: clean(y.division) || 'Unknown',
        writer: known(y.writer) || cfTwinWriter.get(y) || '',
        editor: known(y.editor),
        submittedDay,
        publishedDay,
        editedAt: y.editorAt ?? null,
        editedDay: editedDayOf(
          y.editorAt,
          {
            verified: ypStages.isVerified(y),
            published,
            killed: ypStages.isKilled(y),
            onHold: ypStages.isOnHold(y),
          },
          publishedDay,
        ),
        sentBack: false,
        undated: (ypStages.isSubmitted(y) && !submittedDay) || (published && !publishedDay),
      });
    }

    return { pieces, twins };
  }

  async get(params: {
    startDate?: string;
    endDate?: string;
    divisions?: string[];
  }): Promise<CombinedProductionResult> {
    const [{ pieces, twins }, people] = await Promise.all([this.loadPieces(), this.peopleRepo.find()]);
    const sharedWithYahoo = twins.length;

    const resolve = buildNameResolver(
      people.flatMap((s) => [
        { division: s.primaryDivision, name: s.name, floats: FLOAT_POOLS.has(s.primaryDivision) },
        ...(s.secondaryDivisions || []).map((d) => ({ division: d, name: s.name })),
      ]),
      pieces.map((p) => ({
        division: p.division,
        writer: p.writer || 'Unknown',
        editor: p.editor || 'Unknown',
        allottedBy: 'Unknown',
      })),
    );

    const wantDivisions = params.divisions?.length
      ? new Set(params.divisions.map((d) => canonicalDivision(d).division))
      : null;
    const inRange = (day: string | null) =>
      !!day &&
      (!params.startDate || day >= params.startDate) &&
      (!params.endDate || day <= params.endDate);

    const totals = { submitted: split(), published: split() };
    const byDay = new Map<string, Split>();
    type Tally = { divisions: Map<string, number>; pieces: Piece[] };
    const byWriter = new Map<string, Tally & { submitted: Split; sentBack: number }>();
    const byEditor = new Map<string, Tally & { published: Split }>();
    const byDivision = new Map<string, { submitted: Split; published: Split }>();
    const divisionRow = (d: string) => {
      if (!byDivision.has(d)) byDivision.set(d, { submitted: split(), published: split() });
      return byDivision.get(d)!;
    };
    let undated = 0;

    for (const p of pieces) {
      if (wantDivisions && !wantDivisions.has(p.division)) continue;
      if (p.undated) undated++;

      if (p.submittedDay && inRange(p.submittedDay)) {
        add(totals.submitted, p.yahoo);
        add(divisionRow(p.division).submitted, p.yahoo);
        {
          const name = p.writer ? resolve(p.writer, p.division) : NO_WRITER;
          if (!byWriter.has(name)) {
            byWriter.set(name, { divisions: new Map(), pieces: [], submitted: split(), sentBack: 0 });
          }
          const w = byWriter.get(name)!;
          w.pieces.push(p);
          add(w.submitted, p.yahoo);
          if (p.sentBack) w.sentBack++;
          w.divisions.set(p.division, (w.divisions.get(p.division) ?? 0) + 1);
        }
      }

      if (p.publishedDay && inRange(p.publishedDay)) {
        add(totals.published, p.yahoo);
        add(divisionRow(p.division).published, p.yahoo);
        if (!byDay.has(p.publishedDay)) byDay.set(p.publishedDay, split());
        add(byDay.get(p.publishedDay)!, p.yahoo);
        {
          const name = p.editor ? resolve(p.editor, p.division) : NO_EDITOR;
          if (!byEditor.has(name)) byEditor.set(name, { divisions: new Map(), pieces: [], published: split() });
          const e = byEditor.get(name)!;
          e.pieces.push(p);
          add(e.published, p.yahoo);
          e.divisions.set(p.division, (e.divisions.get(p.division) ?? 0) + 1);
        }
      }
    }

    // Every day of a bounded range gets a row, so a day nothing was published
    // reads as 0 rather than vanishing from the table.
    const days: CombinedProductionResult['days'] = [];
    if (params.startDate && params.endDate && params.startDate <= params.endDate) {
      for (let d = params.startDate; d <= params.endDate; d = shiftDate(d, 1)) {
        days.push({ date: d, published: byDay.get(d) ?? split() });
      }
    } else {
      for (const [date, published] of byDay) days.push({ date, published });
    }
    days.sort((a, b) => b.date.localeCompare(a.date));

    const mainDivision = (m: Map<string, number>) =>
      [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

    // Days worked, inside the range only, so an average is over the days a
    // person actually worked rather than the length of the filter. Writers work
    // on the day they submit; editors on the day their pass ended, falling back
    // to the sheet's publication date when that stamp is missing or outside.
    const range = { startDate: params.startDate, endDate: params.endDate };
    const worked = (days: number, total: number) => ({ daysWorked: days, perDay: perDay(total, days) });
    const nobody = { daysWorked: null, perDay: null };

    return {
      startDate: params.startDate ?? null,
      endDate: params.endDate ?? null,
      totals,
      days,
      writers: [...byWriter.entries()]
        .map(([writer, w]) => ({
          writer,
          division: writer === NO_WRITER ? '' : mainDivision(w.divisions),
          submitted: w.submitted,
          sentBack: w.sentBack,
          ...(writer === NO_WRITER
            ? nobody
            : worked(activeDayCount(w.pieces, (p) => p.submittedDay, range), w.submitted.total)),
        }))
        .sort((a, b) => b.submitted.total - a.submitted.total || a.writer.localeCompare(b.writer)),
      editors: [...byEditor.entries()]
        .map(([editor, e]) => ({
          editor,
          division: editor === NO_EDITOR ? '' : mainDivision(e.divisions),
          published: e.published,
          ...(editor === NO_EDITOR
            ? nobody
            : worked(
                activeDayCount(e.pieces, (p) => p.editedAt, { ...range, fallback: (p) => p.publishedDay }),
                e.published.total,
              )),
        }))
        .sort((a, b) => b.published.total - a.published.total || a.editor.localeCompare(b.editor)),
      divisions: [...byDivision.entries()]
        .map(([division, d]) => ({ division, ...d }))
        .sort((a, b) => b.published.total - a.published.total || a.division.localeCompare(b.division)),
      notes: { sharedWithYahoo, undated },
    };
  }

  /**
   * Written, edited and published per source sheet, Yahoo and Non-Yahoo apart,
   * on the same rules as `get()`: written is submitted, by desk day; published
   * by each sheet's publication date; edited on the desk day of the last pass.
   * Every sheet that has ever synced gets a row, so a quiet one reads 0.
   */
  async roundup(params: { startDate?: string; endDate?: string }): Promise<SheetRoundupResult> {
    const { pieces, twins } = await this.loadPieces();
    const inRange = (day: string | null) =>
      !!day &&
      (!params.startDate || day >= params.startDate) &&
      (!params.endDate || day <= params.endDate);

    const total = counts();
    const sides = { yahoo: new Map<string, RoundupCounts>(), nonYahoo: new Map<string, RoundupCounts>() };
    const sideTotals = { yahoo: counts(), nonYahoo: counts() };
    const byDay = new Map<string, { yahoo: RoundupCounts; nonYahoo: RoundupCounts }>();
    const dayRow = (d: string) => {
      if (!byDay.has(d)) byDay.set(d, { yahoo: counts(), nonYahoo: counts() });
      return byDay.get(d)!;
    };
    for (const p of twins) {
      if (!sides.nonYahoo.has(p.sheet)) sides.nonYahoo.set(p.sheet, counts());
    }

    let undated = 0;
    for (const p of pieces) {
      const side = p.yahoo ? 'yahoo' : 'nonYahoo';
      if (!sides[side].has(p.sheet)) sides[side].set(p.sheet, counts());
      const sheet = sides[side].get(p.sheet)!;
      if (p.undated) undated++;

      const tally = (measure: keyof RoundupCounts, day: string | null) => {
        if (!day || !inRange(day)) return;
        total[measure]++;
        sideTotals[side][measure]++;
        sheet[measure]++;
        dayRow(day)[side][measure]++;
      };
      tally('written', p.submittedDay);
      tally('edited', p.editedDay);
      tally('published', p.publishedDay);
    }

    const days: SheetRoundupResult['days'] = [];
    if (params.startDate && params.endDate && params.startDate <= params.endDate) {
      for (let d = params.startDate; d <= params.endDate; d = shiftDate(d, 1)) {
        days.push({ date: d, ...(byDay.get(d) ?? { yahoo: counts(), nonYahoo: counts() }) });
      }
    } else {
      for (const [date, row] of byDay) days.push({ date, ...row });
    }
    days.sort((a, b) => b.date.localeCompare(a.date));

    const sheetRows = (m: Map<string, RoundupCounts>) =>
      [...m.entries()]
        .map(([sheet, c]) => ({ sheet, ...c }))
        .sort((a, b) => b.published - a.published || b.written - a.written || a.sheet.localeCompare(b.sheet));

    return {
      startDate: params.startDate ?? null,
      endDate: params.endDate ?? null,
      total,
      yahoo: { totals: sideTotals.yahoo, sheets: sheetRows(sides.yahoo) },
      nonYahoo: { totals: sideTotals.nonYahoo, sheets: sheetRows(sides.nonYahoo) },
      days,
      notes: {
        sharedWithYahoo: twins.filter((p) => inRange(p.submittedDay) || inRange(p.editedDay) || inRange(p.publishedDay))
          .length,
        undated,
      },
    };
  }
}
