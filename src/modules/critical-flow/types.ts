// Critical Flow types. The analytics result shapes live in the shared
// production module and are re-exported here, so callers keep importing from
// one place; what remains below is Critical Flow's own sheet-parse shape.

export * from '../production/types';
import type { ProductionFilterParams } from '../production/types';

/** Critical Flow's filter params are the shared ones, under the older name. */
export type CfFilterParams = ProductionFilterParams;

export interface ParsedPiece {
  id: string;
  uniquePieceId: string;
  division: string;
  month: string;
  writer: string;
  editor: string;
  editor2: string;
  allottedBy: string;
  articleType: string;
  yahoo: boolean | null;
  editorialStatus: string;
  editorialStatus2: string;
  sbReason: string;
  wpStatus: string;
  allottedAt: Date | null;
  submittedAt: Date | null;
  submittedEst: Date | null;
  editorAt: Date | null;
  editorAt2: Date | null;
  liveAt: Date | null;
  wpCheckedAt: Date | null;
  publishedDate: string | null;
  date: string | null;
  tatHours: number | null;
  sbHours: number | null;
  title: string;
  titleNorm: string;
  source: string;
  stagingLink: string;
  writerComments: string;
  editorComment: string;
  editorComment2: string;
  articleMap: string;
  plagReport: string;
  rawHash: string;
}
