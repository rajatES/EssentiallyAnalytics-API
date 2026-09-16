import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SocialProfile } from '../facebook/entities/SocialProfile.entity';
import { RevenueMapping } from '../revenue/entities/revenue-mapping.entity';
import { PageMapping } from '../page-mappings/entities/page-mapping.entity';
import {
  buildPageUrl,
  pageNameKey,
  toPageLinkPlatform,
  type PageLinkPlatform,
} from '../../common/page-links';

export interface PageDirectoryEntry {
  /** Display name as the owning table spells it. */
  name: string;
  /** Normalised `name`, for matching across tables — see pageNameKey(). */
  key: string;
  platform: PageLinkPlatform;
  url: string;
  /** Meta Page ID / profile ID, when the source row has one. */
  id: string | null;
  source: 'mapping' | 'profile' | 'revenue';
}

/**
 * Where a link comes from when two tables describe the same account.
 * A hand-entered override beats Meta, and Meta beats the revenue export.
 */
const SOURCE_RANK: Record<PageDirectoryEntry['source'], number> = {
  mapping: 0,
  profile: 1,
  revenue: 2,
};

@Injectable()
export class PageDirectoryService {
  constructor(
    @InjectRepository(SocialProfile)
    private readonly profileRepo: Repository<SocialProfile>,
    @InjectRepository(RevenueMapping)
    private readonly revenueMappingRepo: Repository<RevenueMapping>,
    @InjectRepository(PageMapping)
    private readonly pageMappingRepo: Repository<PageMapping>,
  ) {}

  /**
   * Every account we can produce a click-through URL for, merged across the
   * three tables that name them.
   *
   * The Traffic page is the reason this exists: its rows know a page name and
   * nothing else, so it resolves links by looking a name up here. Reports and
   * Revenue could build their own URLs from the IDs they already hold, but
   * read the same directory so all three agree — including on the overrides.
   */
  async getDirectory(): Promise<PageDirectoryEntry[]> {
    const [profiles, revenueMappings, pageMappings] = await Promise.all([
      this.profileRepo.find({
        where: { isActive: true },
        select: ['profileId', 'name', 'platform', 'username'],
      }),
      this.revenueMappingRepo.find(),
      this.pageMappingRepo.find(),
    ]);

    const candidates: PageDirectoryEntry[] = [];

    const push = (
      name: string | null | undefined,
      platform: PageLinkPlatform | null,
      url: string | null,
      id: string | null,
      source: PageDirectoryEntry['source'],
    ) => {
      const clean = (name || '').trim();
      if (!clean || !platform || !url) return;
      candidates.push({ name: clean, key: pageNameKey(clean), platform, url, id, source });
    };

    for (const p of profiles) {
      const platform = toPageLinkPlatform(p.platform);
      push(
        p.name,
        platform,
        platform
          ? buildPageUrl({ platform, id: p.profileId, handle: p.username, name: p.name })
          : null,
        p.profileId,
        'profile',
      );
    }

    for (const m of revenueMappings) {
      push(
        m.pageName,
        'facebook',
        buildPageUrl({
          platform: 'facebook',
          id: m.pageId,
          name: m.pageName,
          explicitUrl: m.pageUrl,
        }),
        m.pageId,
        'revenue',
      );
    }

    // page_mappings holds one row per utm_medium, so a page with four mediums
    // appears four times. Only the rows carrying an override contribute a URL,
    // and identical duplicates collapse in the dedupe below.
    for (const m of pageMappings) {
      const platform =
        toPageLinkPlatform(m.platform) ?? toPageLinkPlatform(m.utmSource);
      if (!platform) continue;
      push(
        m.pageName,
        platform,
        buildPageUrl({ platform, name: m.pageName, explicitUrl: m.pageUrl }),
        null,
        'mapping',
      );
    }

    return this.dedupe(candidates);
  }

  /**
   * Collapse to one entry per (platform, name key).
   *
   * When the winning source still disagrees with itself — two different Meta
   * pages whose names normalise the same — the entry is dropped rather than
   * picked arbitrarily. A silently wrong link is worse than a name that simply
   * isn't clickable, and the override field is the fix.
   */
  private dedupe(candidates: PageDirectoryEntry[]): PageDirectoryEntry[] {
    const buckets = new Map<string, PageDirectoryEntry[]>();
    for (const entry of candidates) {
      const bucketKey = `${entry.platform}::${entry.key}`;
      const bucket = buckets.get(bucketKey);
      if (bucket) bucket.push(entry);
      else buckets.set(bucketKey, [entry]);
    }

    const resolved: PageDirectoryEntry[] = [];
    for (const bucket of buckets.values()) {
      const bestRank = Math.min(...bucket.map((e) => SOURCE_RANK[e.source]));
      const top = bucket.filter((e) => SOURCE_RANK[e.source] === bestRank);
      const distinct = new Set(top.map((e) => e.url));
      if (distinct.size === 1) resolved.push(top[0]);
    }

    return resolved.sort(
      (a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name),
    );
  }
}
