/**
 * The shape the production analytics need from a content piece, whichever
 * pipeline it came from.
 *
 * Critical Flow and Yahoo run the same lifecycle — allot, write, submit, edit,
 * publish — over different source sheets, so the dashboards are the same
 * dashboard twice. Rather than keep two copies of the analytics in step by
 * hand, both entities satisfy this interface and share one implementation.
 *
 * The second-pass fields are optional because Yahoo has a single editorial
 * pass and no send-backs: there is no column to fill, so the Yahoo table has
 * no such column rather than a permanently empty one.
 */
export interface ProductionPiece {
  id: string;
  uniquePieceId: string;

  // ── Dimensions ──
  division: string;
  month: string;
  writer: string;
  editor: string;
  allottedBy: string;
  articleType: string;

  // ── Status ──
  editorialStatus: string;
  wpStatus: string;

  // ── Lifecycle timestamps ──
  allottedAt: Date | null;
  submittedAt: Date | null;
  editorAt: Date | null;
  liveAt: Date | null;
  wpCheckedAt: Date | null;
  publishedDate: string | null;
  /** Date-only anchor used by every date filter and timeline. */
  date: string | null;

  // ── Durations ──
  tatHours: number | null;

  // ── Text ──
  title: string;
  titleNorm: string;
  source: string;
  stagingLink: string;
  writerComments: string;
  editorComment: string;
  plagReport: string;

  // ── Second editorial pass — Critical Flow only ──
  editor2?: string;
  editorialStatus2?: string;
  sbReason?: string;
  editorAt2?: Date | null;
  sbHours?: number | null;
  editorComment2?: string;
}

/**
 * A rostered person, as the roster board needs them. Pipelines that track
 * fewer attributes supply empty values rather than a narrower type, so the
 * board renders the same way for both.
 */
export interface RosterPerson {
  id: string;
  division: string;
  name: string;
  role: string;
  /** 'writer' | 'editor' | other — drives the per-division head counts. */
  roleGroup: string;
  weekoff: string;
  shift: string;
  email: string;
  dailyTarget: number | null;
  /**
   * Works across every division (Associates, the newsroom). Listed once under
   * their pool, but offered to every division's name resolver.
   */
  floats?: boolean;
}

/**
 * Lifecycle predicates, supplied per pipeline. Keeping these behind an
 * interface is what lets one analytics implementation serve a two-pass
 * workflow with send-backs and a single-pass one without.
 */
export interface StageApi<P> {
  reachedEditorial(p: P): boolean;
  isSubmitted(p: P): boolean;
  isVerified(p: P): boolean;
  isSentBack(p: P): boolean;
  isOpenSendBack(p: P): boolean;
  isPublished(p: P): boolean;
  isKilled(p: P): boolean;
  isOnHold(p: P): boolean;
  pendingStage(p: P, now: Date): string | null;
  pendingAnchor(p: P, stage: string): Date | null;
}
