import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CfPiece } from '../critical-flow/entities/cf-piece.entity';
import * as cfStages from '../critical-flow/stages';
import { YpPiece } from '../yahoo-production/entities/yp-piece.entity';
import * as ypStages from '../yahoo-production/stages';
import { buildNameResolver } from '../production/name-resolver';
import { normalizeTitleKey, toDateOnly } from '../production/normalization';
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
  writers: { writer: string; division: string; submitted: Split; sentBack: number }[];
  editors: { editor: string; division: string; published: Split }[];
  divisions: { division: string; submitted: Split; published: Split }[];
  notes: {
    /** CF pieces also tracked on the Yahoo sheet, all dates — each counted once, as Yahoo. */
    sharedWithYahoo: number;
    /** Pieces with no stamp to place them on any day, so outside every range. */
    undated: number;
  };
}

interface Piece {
  yahoo: boolean;
  division: string;
  writer: string;
  editor: string;
  submittedDay: string | null;
  publishedDay: string | null;
  sentBack: boolean;
  /** Submitted or published, yet nothing places it on a day. */
  undated: boolean;
}

/** A shared title shorter than this is too generic to prove two rows are one piece. */
const MIN_TITLE_KEY = 20;

const split = (): Split => ({ yahoo: 0, nonYahoo: 0, total: 0 });
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

  async get(params: {
    startDate?: string;
    endDate?: string;
    divisions?: string[];
  }): Promise<CombinedProductionResult> {
    const [cf, yp, people] = await Promise.all([
      this.cfRepo.find(),
      this.ypRepo.find(),
      this.peopleRepo.find(),
    ]);

    const pieces: Piece[] = [];
    const yahooByTitle = new Map<string, YpPiece>();
    for (const y of yp) {
      const key = normalizeTitleKey(y.title);
      if (key.length >= MIN_TITLE_KEY && !yahooByTitle.has(key)) yahooByTitle.set(key, y);
    }

    let sharedWithYahoo = 0;
    const cfTwinWriter = new Map<YpPiece, string>();
    for (const p of cf) {
      const key = normalizeTitleKey(p.title);
      const twin = key.length >= MIN_TITLE_KEY ? yahooByTitle.get(key) : undefined;
      if (twin) {
        sharedWithYahoo++;
        if (known(p.writer)) cfTwinWriter.set(twin, p.writer);
        continue;
      }
      const stamp = p.submittedAt || p.editorAt;
      const published = cfStages.isPublished(p);
      const submittedDay = cfStages.isSubmitted(p) ? (stamp ? opsDayOf(stamp) : p.date) : null;
      const publishedDay = published
        ? p.publishedDate ?? toDateOnly(p.liveAt ?? p.editorAt2 ?? p.editorAt ?? null)
        : null;
      pieces.push({
        yahoo: false,
        division: p.division,
        writer: known(p.writer),
        // The pass that cleared the piece: the second editor after a send-back.
        editor: known(p.editor2) || known(p.editor),
        submittedDay,
        publishedDay,
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
        writer: known(y.writer) || cfTwinWriter.get(y) || '',
        editor: known(y.editor),
        submittedDay,
        publishedDay,
        sentBack: false,
        undated: (ypStages.isSubmitted(y) && !submittedDay) || (published && !publishedDay),
      });
    }

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
    const byWriter = new Map<string, { divisions: Map<string, number>; submitted: Split; sentBack: number }>();
    const byEditor = new Map<string, { divisions: Map<string, number>; published: Split }>();
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
          if (!byWriter.has(name)) byWriter.set(name, { divisions: new Map(), submitted: split(), sentBack: 0 });
          const w = byWriter.get(name)!;
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
          if (!byEditor.has(name)) byEditor.set(name, { divisions: new Map(), published: split() });
          const e = byEditor.get(name)!;
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
        }))
        .sort((a, b) => b.submitted.total - a.submitted.total || a.writer.localeCompare(b.writer)),
      editors: [...byEditor.entries()]
        .map(([editor, e]) => ({
          editor,
          division: editor === NO_EDITOR ? '' : mainDivision(e.divisions),
          published: e.published,
        }))
        .sort((a, b) => b.published.total - a.published.total || a.editor.localeCompare(b.editor)),
      divisions: [...byDivision.entries()]
        .map(([division, d]) => ({ division, ...d }))
        .sort((a, b) => b.published.total - a.published.total || a.division.localeCompare(b.division)),
      notes: { sharedWithYahoo, undated },
    };
  }
}
