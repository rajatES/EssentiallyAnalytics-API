import { CfPiece } from './entities/cf-piece.entity';

/**
 * Lifecycle predicates for a Critical Flow piece — the single definition of
 * "submitted", "verified", "sent back" and so on, shared by the dashboard
 * analytics and the resource board so the two can never disagree about a
 * piece's state.
 *
 * A division may skip filling in "Submitted At" entirely and still run the
 * piece through editorial, so submission is inferred from any later evidence
 * rather than trusted as a lone column.
 */

/** A piece untouched for this long is treated as abandoned rather than pending. */
export const STALE_DAYS = 21;

export type PendingStage =
  | 'Awaiting Submission'
  | 'Awaiting Editorial'
  | 'Sent Back'
  | 'Awaiting Live';

export function reachedEditorial(p: CfPiece): boolean {
  return !!p.editorAt || !!p.editorialStatus || p.editor !== 'Unknown';
}

export function isSubmitted(p: CfPiece): boolean {
  return !!p.submittedAt || !!p.stagingLink || reachedEditorial(p);
}

export function isVerified(p: CfPiece): boolean {
  const s = p.editorialStatus;
  const s2 = p.editorialStatus2;
  return (
    s === 'Verified' || s2 === 'Verified' ||
    s === 'Published' || s === 'PR Published' || s === 'Scheduled'
  );
}

/** Went back to the writer at least once. */
export function isSentBack(p: CfPiece): boolean {
  return (
    p.editorialStatus === 'Sent Back' ||
    !!p.sbReason ||
    !!p.editorAt2 ||
    !!p.editorialStatus2
  );
}

/** Sent back and not yet cleared by a later pass. */
export function isOpenSendBack(p: CfPiece): boolean {
  if (!isSentBack(p)) return false;
  return p.editorialStatus2 !== 'Verified' && p.editorialStatus !== 'Verified';
}

export function isPublished(p: CfPiece): boolean {
  return (
    !!p.publishedDate ||
    !!p.liveAt ||
    p.wpStatus.toLowerCase() === 'live' ||
    p.editorialStatus === 'Published' ||
    p.editorialStatus === 'PR Published'
  );
}

export function isKilled(p: CfPiece): boolean {
  return p.editorialStatus === 'Scrapped';
}

export function isOnHold(p: CfPiece): boolean {
  return p.editorialStatus === 'On Hold';
}

/**
 * Which queue a piece is sitting in, or null when it is finished, killed or
 * so old that calling it "pending" would be misleading.
 */
export function pendingStage(p: CfPiece, now: Date): PendingStage | null {
  if (isKilled(p) || isOnHold(p)) return null;
  if (isPublished(p)) return null;

  const anchor = p.editorAt2 || p.editorAt || p.submittedAt || p.allottedAt;
  if (anchor) {
    const ageDays = (now.getTime() - new Date(anchor).getTime()) / 86400000;
    if (ageDays > STALE_DAYS) return null;
  }

  if (isOpenSendBack(p)) return 'Sent Back';
  if (!isSubmitted(p)) return 'Awaiting Submission';
  if (!isVerified(p)) return 'Awaiting Editorial';
  return 'Awaiting Live';
}

export function pendingAnchor(p: CfPiece, stage: PendingStage): Date | null {
  switch (stage) {
    case 'Awaiting Submission': return p.allottedAt;
    case 'Awaiting Editorial': return p.submittedAt || p.allottedAt;
    case 'Sent Back': return p.editorAt || p.submittedAt;
    case 'Awaiting Live': return p.editorAt2 || p.editorAt || p.submittedAt;
  }
}

/** Sub-feed label from a month tab like "September 2026 (Tennis)", else ''. */
export function subFeedOf(p: CfPiece): string {
  const m = /\(([^)]+)\)\s*$/.exec(p.month || '');
  return m ? m[1].trim() : '';
}
