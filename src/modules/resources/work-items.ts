import { CfPiece } from '../critical-flow/entities/cf-piece.entity';
import * as cfStages from '../critical-flow/stages';
import { YpPiece } from '../yahoo-production/entities/yp-piece.entity';
import * as ypStages from '../yahoo-production/stages';
import { normalizeTitleKey } from '../production/normalization';
import { NamedPiece } from '../production/name-resolver';
import { canonicalDivision } from './divisions';

export type WorkStage = 'Awaiting Submission' | 'Awaiting Editorial' | 'Sent Back' | 'Awaiting Live';

/**
 * One piece of work, whichever sheet recorded it. Divisions are in board
 * terms, and the lifecycle is pre-evaluated with the recording pipeline's own
 * stage rules so the board never has to know which pipeline a piece came from.
 */
export interface WorkItem {
  id: string;
  /** Which sheet(s) carry it; 'both' is a CF piece the Yahoo sheet also tracks. */
  source: 'cf' | 'yahoo' | 'both';
  division: string;
  subFeed: string;
  writer: string;
  /** Every editor who handled it — CF's passes plus Yahoo's publisher. */
  editors: string[];
  allottedBy: string;
  submittedAt: Date | null;
  editorAt: Date | null;
  publishedDate: string | null;
  date: string | null;
  published: boolean;
  pending: WorkStage | null;
}

/** Titles shorter than this are too generic to prove two rows are one piece. */
const MIN_TITLE_KEY = 20;

function known(name: string | undefined | null): string {
  return name && name !== 'Unknown' ? name : '';
}

/**
 * Critical Flow and Yahoo pieces as one work list.
 *
 * A CF piece marked Yahoo = Yes is usually tracked again, under the same
 * title, on the Yahoo sheet (354 of September's pieces) — the same work
 * recorded twice. Those pairs merge into one item: the CF row leads, and the
 * Yahoo row fills what CF left blank (often the editor) and adds its
 * publisher. Counting both would double every such writer's output.
 */
export function buildWorkItems(cf: CfPiece[], yahoo: YpPiece[], now: Date): WorkItem[] {
  const items: WorkItem[] = [];
  const byTitle = new Map<string, WorkItem>();

  for (const p of cf) {
    const item: WorkItem = {
      id: `cf:${p.id}`,
      source: 'cf',
      division: p.division,
      subFeed: cfStages.subFeedOf(p),
      writer: p.writer,
      editors: [known(p.editor), known(p.editor2)].filter(Boolean),
      allottedBy: p.allottedBy,
      submittedAt: p.submittedAt,
      editorAt: p.editorAt || p.editorAt2,
      publishedDate: p.publishedDate,
      date: p.date,
      published: cfStages.isPublished(p),
      pending: cfStages.pendingStage(p, now),
    };
    items.push(item);
    const key = normalizeTitleKey(p.title);
    if (key.length >= MIN_TITLE_KEY && !byTitle.has(key)) byTitle.set(key, item);
  }

  for (const y of yahoo) {
    const key = normalizeTitleKey(y.title);
    const twin = key.length >= MIN_TITLE_KEY ? byTitle.get(key) : undefined;
    const ref = canonicalDivision(y.division);
    const yEditor = known(y.editor);
    const yPublished = ypStages.isPublished(y);

    if (twin && twin.source === 'cf') {
      twin.source = 'both';
      if (!known(twin.writer)) twin.writer = y.writer;
      if (yEditor && !twin.editors.some((e) => e.toLowerCase() === yEditor.toLowerCase())) {
        twin.editors.push(yEditor);
      }
      twin.submittedAt = twin.submittedAt || y.submittedAt;
      twin.editorAt = twin.editorAt || y.editorAt;
      twin.publishedDate = twin.publishedDate || y.publishedDate;
      twin.date = twin.date || y.date;
      if (yPublished) {
        twin.published = true;
        twin.pending = null;
      }
      continue;
    }

    items.push({
      id: `yp:${y.id}`,
      source: 'yahoo',
      division: ref.division,
      subFeed: ref.subFeed,
      writer: y.writer,
      editors: yEditor ? [yEditor] : [],
      allottedBy: y.allottedBy,
      submittedAt: y.submittedAt,
      editorAt: y.editorAt,
      publishedDate: y.publishedDate,
      date: y.date,
      published: yPublished,
      pending: ypStages.pendingStage(y, now),
    });
  }
  return items;
}

/** The shape the name resolver reads; extra editors ride along as editor2. */
export function namedPieces(items: WorkItem[]): NamedPiece[] {
  const out: NamedPiece[] = [];
  for (const w of items) {
    out.push({
      division: w.division,
      writer: w.writer,
      editor: w.editors[0] || 'Unknown',
      editor2: w.editors[1] || '',
      allottedBy: w.allottedBy,
    });
    for (const extra of w.editors.slice(2)) {
      out.push({ division: w.division, writer: 'Unknown', editor: extra, allottedBy: 'Unknown' });
    }
  }
  return out;
}
