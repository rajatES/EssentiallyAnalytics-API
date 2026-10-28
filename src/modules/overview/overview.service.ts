import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { platformForSource } from '../../common/traffic-platforms';
import { TrafficPageDaily } from '../utm-analytics/entities/traffic-page-daily.entity';
import {
  CombinedProductionService,
  NO_EDITOR,
  NO_WRITER,
  type PublishedArticle,
} from '../resources/combined-production.service';
import { shiftDate, todayIst } from '../production/time';
import { articleSlug, SlugMatcher } from './content-match';
import type { OverviewArticle, OverviewGroup, OverviewResult, PlatformSessions, Reach } from './types';

/**
 * Traffic is read from this long before the period, so a page that was
 * already drawing landings reads as older than the period's articles instead
 * of appearing to start on its first day.
 */
const LOOKBACK_DAYS = 7;
/** Articles this close before the period still compete for its pages, so a page goes to its real owner. */
const NEIGHBOUR_DAYS = 4;

const noSessions = (): PlatformSessions => ({ fb: 0, threads: 0, reddit: 0 });
const reach = (): Reach => ({ published: 0, reached: 0, sessions: 0, platforms: noSessions() });

function tally(r: Reach, a: OverviewArticle) {
  r.published++;
  if (a.sessions > 0) r.reached++;
  r.sessions += a.sessions;
  for (const k of Object.keys(r.platforms) as (keyof PlatformSessions)[]) r.platforms[k] += a.platforms[k];
}

interface SlugTraffic {
  firstDay: string;
  sessions: number;
  /** Landings dated inside the period. */
  inPeriod: number;
  platforms: PlatformSessions;
}

/**
 * Production and social traffic in one place: every Critical Flow and Yahoo
 * article published in a period, who wrote and edited it, and the social
 * landings (Facebook, Threads, Reddit) its page drew from publication on.
 * Articles come from the Combined tab's rules, so the published counts and the
 * people credited agree with it; pages are matched by headline, see
 * content-match.ts.
 */
@Injectable()
export class OverviewService {
  constructor(
    @InjectRepository(TrafficPageDaily) private readonly pageRepo: Repository<TrafficPageDaily>,
    private readonly combined: CombinedProductionService,
  ) {}

  private async landings(from: string, startDate: string, endDate: string) {
    const rows = await this.pageRepo
      .createQueryBuilder('p')
      .select('p.pagePath', 'path')
      .addSelect('p.utmSource', 'source')
      .addSelect(`TO_CHAR(MIN(p.date), 'YYYY-MM-DD')`, 'firstDay')
      .addSelect('SUM(p.sessions)', 'sessions')
      .addSelect('SUM(CASE WHEN p.date BETWEEN :startDate AND :endDate THEN p.sessions ELSE 0 END)', 'inPeriod')
      .where('p.date >= :from', { from })
      .setParameters({ startDate, endDate })
      .groupBy('p.pagePath')
      .addGroupBy('p.utmSource')
      .getRawMany<{ path: string; source: string; firstDay: string; sessions: string; inPeriod: string }>();

    const bySlug = new Map<string, SlugTraffic>();
    let allInPeriod = 0;
    for (const r of rows) {
      const platform = platformForSource(r.source)?.key;
      if (!platform) continue;
      const inPeriod = Number(r.inPeriod) || 0;
      allInPeriod += inPeriod;
      const slug = articleSlug(r.path);
      if (!slug) continue;
      if (!bySlug.has(slug)) bySlug.set(slug, { firstDay: r.firstDay, sessions: 0, inPeriod: 0, platforms: noSessions() });
      const t = bySlug.get(slug)!;
      if (r.firstDay < t.firstDay) t.firstDay = r.firstDay;
      const sessions = Number(r.sessions) || 0;
      t.sessions += sessions;
      t.inPeriod += inPeriod;
      t.platforms[platform] += sessions;
    }
    return { bySlug, allInPeriod };
  }

  private async trafficSpan(): Promise<OverviewResult['traffic']> {
    const row = await this.pageRepo
      .createQueryBuilder('p')
      .select(`TO_CHAR(MIN(p.date), 'YYYY-MM-DD')`, 'firstDay')
      .addSelect(`TO_CHAR(MAX(p.date), 'YYYY-MM-DD')`, 'lastDay')
      .getRawOne<{ firstDay: string | null; lastDay: string | null }>();
    return { from: row?.firstDay ?? null, through: row?.lastDay ?? null };
  }

  async get(params: { startDate?: string; endDate?: string }): Promise<OverviewResult> {
    const endDate = params.endDate ?? todayIst();
    const startDate = params.startDate ?? shiftDate(endDate, -6);

    const [published, { bySlug, allInPeriod }, traffic] = await Promise.all([
      this.combined.publishedArticles(),
      this.landings(shiftDate(startDate, -LOOKBACK_DAYS), startDate, endDate),
      this.trafficSpan(),
    ]);

    const matcher = new SlugMatcher([...bySlug].map(([slug, t]) => ({ slug, firstDay: t.firstDay })));
    const earliest = shiftDate(startDate, -NEIGHBOUR_DAYS);
    const contenders = published.filter((a) => a.publishedDay >= earliest && a.publishedDay <= endDate);

    // A page goes to the one article that matches it best. Without this, a CF
    // piece and its Yahoo twin whose titles differ by a word would both claim it.
    const claims = new Map<string, { article: PublishedArticle; score: number }>();
    const matched = new Map<PublishedArticle, string[]>();
    for (const a of contenders) {
      const m = matcher.match(a.title, a.publishedDay);
      if (!m) continue;
      matched.set(a, m.slugs);
      for (const slug of m.slugs) {
        const held = claims.get(slug);
        if (!held || m.score > held.score) claims.set(slug, { article: a, score: m.score });
      }
    }

    let theseArticles = 0;
    const articles: OverviewArticle[] = contenders
      .filter((a) => a.publishedDay >= startDate)
      .map((a) => {
        const slugs = (matched.get(a) ?? [])
          .filter((s) => claims.get(s)?.article === a)
          .sort((x, y) => bySlug.get(y)!.sessions - bySlug.get(x)!.sessions);
        const platforms = noSessions();
        let sessions = 0;
        for (const s of slugs) {
          const t = bySlug.get(s)!;
          sessions += t.sessions;
          theseArticles += t.inPeriod;
          for (const k of Object.keys(platforms) as (keyof PlatformSessions)[]) platforms[k] += t.platforms[k];
        }
        return {
          id: a.id,
          title: a.title,
          desk: a.yahoo ? 'yahoo' : 'nonYahoo',
          division: a.division,
          writer: a.writer,
          editor: a.editor,
          publishedDay: a.publishedDay,
          path: slugs.length ? `/${slugs[0]}/` : null,
          sessions,
          platforms,
        } satisfies OverviewArticle;
      })
      .sort((x, y) => y.sessions - x.sessions || y.publishedDay.localeCompare(x.publishedDay));

    const totals = reach();
    const desks = { yahoo: reach(), nonYahoo: reach() };
    for (const a of articles) {
      tally(totals, a);
      tally(desks[a.desk], a);
    }

    return {
      startDate,
      endDate,
      traffic,
      totals,
      desks,
      landings: { all: allInPeriod, theseArticles },
      writers: groupBy(articles, (a) => a.writer, NO_WRITER),
      editors: groupBy(articles, (a) => a.editor, NO_EDITOR),
      divisions: groupBy(articles, (a) => a.division),
      articles,
    };
  }
}

function groupBy(articles: OverviewArticle[], nameOf: (a: OverviewArticle) => string, nobody?: string): OverviewGroup[] {
  const groups = new Map<string, { reach: Reach; divisions: Map<string, number>; top: OverviewArticle | null }>();
  for (const a of articles) {
    const name = nameOf(a);
    if (!groups.has(name)) groups.set(name, { reach: reach(), divisions: new Map(), top: null });
    const g = groups.get(name)!;
    tally(g.reach, a);
    g.divisions.set(a.division, (g.divisions.get(a.division) ?? 0) + 1);
    if (a.path && a.sessions > (g.top?.sessions ?? 0)) g.top = a;
  }
  return [...groups.entries()]
    .map(([name, g]) => ({
      name,
      division: name === nobody ? '' : ([...g.divisions.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? ''),
      ...g.reach,
      top: g.top?.path ? { title: g.top.title, path: g.top.path, sessions: g.top.sessions } : null,
    }))
    .sort((x, y) => y.sessions - x.sessions || y.published - x.published || x.name.localeCompare(y.name));
}
