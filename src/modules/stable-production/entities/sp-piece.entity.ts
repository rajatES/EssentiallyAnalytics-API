import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * One row per stable piece (a player profile: parents, net worth, WAGs…),
 * mirrored from the Stable source workbook, where each tab is one event.
 *
 * The sheet keeps no reliable timestamps, so there are none here: every
 * number the page shows is where the piece stands now, grouped by event.
 */
@Entity('sp_pieces')
export class SpPiece {
  @PrimaryColumn()
  id: string;

  // ── Event (the source tab) ──

  @Index()
  @Column()
  event: string;

  /** The tab's position in the workbook; the desk keeps the newest leftmost. */
  @Column({ type: 'int', default: 0 })
  eventOrder: number;

  @Index()
  @Column({ default: 'Other' })
  sport: string;

  /** Row number in the tab, so a piece can be found in the sheet. */
  @Column({ type: 'int', default: 0 })
  sheetRow: number;

  // ── Piece ──

  @Column({ type: 'text', default: '' })
  player: string;

  @Index()
  @Column({ default: 'Unspecified' })
  stableType: string;

  /** "New" | "Update" | '' when the column is blank or mis-entered. */
  @Column({ default: '' })
  pieceKind: string;

  /** The sheet's headline, or "Player — Type" where the desk left it blank. */
  @Column({ type: 'text', default: '' })
  title: string;

  /** False where the Title column was blank and `title` was composed. */
  @Column({ default: false })
  hasHeadline: boolean;

  // ── People ──

  @Index()
  @Column({ default: 'Unknown' })
  writer: string;

  @Index()
  @Column({ default: 'Unknown' })
  editor: string;

  // ── Status ──

  /** Editing Status as typed, normalised for case and spelling. */
  @Column({ default: '' })
  editingStatus: string;

  /** Derived lifecycle stage; see normalize.ts. */
  @Index()
  @Column({ default: 'Awaiting Submission' })
  stage: string;

  @Column({ type: 'text', default: '' })
  writtenStatus: string;

  // ── Links and notes ──

  @Column({ type: 'text', default: '' })
  researchDoc: string;

  @Column({ type: 'text', default: '' })
  submissionDoc: string;

  @Column({ type: 'text', default: '' })
  stagingLink: string;

  @Column({ type: 'text', default: '' })
  publishedUrl: string;

  /** Scheduling Time as written — a clock, "schd", or a note. */
  @Column({ type: 'text', default: '' })
  scheduleNote: string;

  @Column({ type: 'text', default: '' })
  editorComments: string;

  // ── Change detection ──

  @Column({ type: 'text', default: '' })
  rawHash: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
