import { YpPiece } from './entities/yp-piece.entity';

/**
 * Lifecycle predicates for a Yahoo piece — the single definition of
 * "submitted", "verified" and "published", shared by every surface of the
 * dashboard so none of them can disagree.
 *
 * Yahoo runs one editorial pass and has no send-back loop: a piece is either
 * still moving, verified and published, scrapped, or on hold. The send-back
 * predicates are therefore constant false rather than absent, which lets the
 * shared analytics run unchanged — the send-back surfaces simply come back
 * empty instead of needing to be special-cased everywhere.
 */

/** A piece untouched for this long is treated as abandoned rather than pending. */
export const STALE_DAYS = 21;

export type PendingStage =
  | 'Awaiting Submission'
  | 'Awaiting Editorial'
  | 'Awaiting Live';

/** Statuses that mean editorial cleared the piece. */
const VERIFIED = new Set(['Verified', 'Published', 'Scheduled', 'Live']);

export function reachedEditorial(p: YpPiece): boolean {
  return !!p.editorAt || !!p.editorialStatus || p.editor !== 'Unknown';
}

export function isSubmitted(p: YpPiece): boolean {
  return !!p.submittedAt || !!p.stagingLink || reachedEditorial(p);
}

export function isVerified(p: YpPiece): boolean {
  return VERIFIED.has(p.editorialStatus) || isPublished(p);
}

/** Yahoo has no rework loop, so nothing is ever sent back. */
export function isSentBack(_p: YpPiece): boolean {
  return false;
}

export function isOpenSendBack(_p: YpPiece): boolean {
  return false;
}

export function isPublished(p: YpPiece): boolean {
  return (
    !!p.publishedDate ||
    !!p.liveAt ||
    p.wpStatus.toLowerCase() === 'publish' ||
    p.wpStatus.toLowerCase() === 'live' ||
    p.editorialStatus === 'Published'
  );
}

export function isKilled(p: YpPiece): boolean {
  return p.editorialStatus === 'Scrapped';
}

export function isOnHold(p: YpPiece): boolean {
  return p.editorialStatus === 'On Hold';
}

/**
 * Which queue a piece is sitting in, or null when it is finished, killed or so
 * old that calling it "pending" would be misleading.
 */
export function pendingStage(p: YpPiece, now: Date): PendingStage | null {
  if (isKilled(p) || isOnHold(p)) return null;
  if (isPublished(p)) return null;

  const anchor = p.editorAt || p.submittedAt || p.allottedAt;
  if (anchor) {
    const ageDays = (now.getTime() - new Date(anchor).getTime()) / 86400000;
    if (ageDays > STALE_DAYS) return null;
  }

  if (!isSubmitted(p)) return 'Awaiting Submission';
  if (!isVerified(p)) return 'Awaiting Editorial';
  return 'Awaiting Live';
}

export function pendingAnchor(p: YpPiece, stage: PendingStage): Date | null {
  switch (stage) {
    case 'Awaiting Submission':
      return p.allottedAt;
    case 'Awaiting Editorial':
      return p.submittedAt || p.allottedAt;
    case 'Awaiting Live':
      return p.editorAt || p.submittedAt;
  }
}
