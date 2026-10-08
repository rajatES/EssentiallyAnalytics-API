import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('social_profiles')
export class SocialProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  profileId: string;

  @Column()
  name: string;

  @Column()
  platform: string;

  @Column()
  accessToken: string;

  @Column({ default: true })
  isActive: boolean;

  /**
   * Vanity handle from Meta ('essentiallygolf'). Facebook links fine without
   * it — a Page ID resolves on its own — but an Instagram Business Account ID
   * is not the number in a profile URL, so Instagram has no link until this is
   * populated. Filled on connect, on every sync, and by the
   * `profiles/refresh-usernames` backfill.
   */
  @Column({ type: 'varchar', nullable: true })
  username: string | null;

  /**
   * The Facebook user whose login minted this profile's token. Lets pages from
   * several Facebook accounts coexist: reconnecting or disconnecting one account
   * only touches the pages it granted. Null for rows connected before this was
   * tracked; they pick it up the next time their account reconnects.
   */
  @Column({ type: 'varchar', nullable: true })
  connectedViaId: string | null;

  @Column({ type: 'varchar', nullable: true })
  connectedViaName: string | null;

  @Column({ default: 'COMPLETED' })
  syncState: string;

  @Column({ type: 'text', nullable: true })
  lastSyncError: string;
}
