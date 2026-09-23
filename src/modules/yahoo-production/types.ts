// Yahoo Production types. The analytics result shapes are the shared ones and
// are re-exported here so callers import from a single place; below are the
// sheet-parse shapes this pipeline alone uses.

export * from '../production/types';
import type { ProductionFilterParams } from '../production/types';

export type YpFilterParams = ProductionFilterParams;

export interface ParsedYpPiece {
  id: string;
  uniquePieceId: string;
  division: string;
  month: string;
  writer: string;
  editor: string;
  allottedBy: string;
  articleType: string;
  enhancement: string;
  editorialStatus: string;
  wpStatus: string;
  allottedAt: Date | null;
  submittedAt: Date | null;
  editorAt: Date | null;
  liveAt: Date | null;
  wpCheckedAt: Date | null;
  publishedDate: string | null;
  date: string | null;
  tatHours: number | null;
  title: string;
  titleNorm: string;
  source: string;
  stagingLink: string;
  writerComments: string;
  editorComment: string;
  plagReport: string;
  rawHash: string;
}

export interface ParsedYpQuota {
  id: string;
  division: string;
  divisions: string[];
  quota: number | null;
  window: string;
  poc: string;
  rawHash: string;
}

/**
 * A quota row and how the selected period measured against it. Grouped by
 * quota row rather than by division, because one row can cover two content
 * divisions ("Tennis+Olympics") and splitting it would compare each half
 * against the whole target.
 */
export interface YpQuotaAttainment {
  /** The quota row's own label, e.g. "Tennis+Olympics". */
  quotaGroup: string;
  /** Content divisions this row covers. */
  divisions: string[];
  quota: number | null;
  window: string;
  poc: string;
  allotted: number;
  published: number;
  /** Distinct days in the period with any published output. */
  activeDays: number;
  /** Published pieces per active day. */
  perDay: number;
  /** perDay against quota, as a percentage; null where no quota is recorded. */
  attainment: number | null;
}
