import type { TrafficPlatformKey } from '../../common/traffic-platforms';

export type PlatformSessions = Record<TrafficPlatformKey, number>;

export interface Reach {
  published: number;
  /** Published articles whose page drew at least one social landing. */
  reached: number;
  /** Social landings on those pages, from publication to the last synced day. */
  sessions: number;
  platforms: PlatformSessions;
}

export interface OverviewArticle {
  id: string;
  title: string;
  desk: 'yahoo' | 'nonYahoo';
  division: string;
  writer: string;
  editor: string;
  publishedDay: string;
  /** The matched page, e.g. "/nfl-active-news-…/"; null when no page matched. */
  path: string | null;
  sessions: number;
  platforms: PlatformSessions;
}

export interface OverviewGroup extends Reach {
  name: string;
  /** Writers and editors: the division most of their articles sit in. */
  division: string;
  top: { title: string; path: string; sessions: number } | null;
}

export interface OverviewResult {
  startDate: string;
  endDate: string;
  /** The span of landing-page traffic on record; null when none has synced. */
  traffic: { from: string | null; through: string | null };
  totals: Reach;
  desks: { yahoo: Reach; nonYahoo: Reach };
  /**
   * Social landings dated inside the period itself: on every page of the site,
   * and on the articles published in it — how much of the period's social
   * traffic new production drew, against the back catalogue.
   */
  landings: { all: number; theseArticles: number };
  writers: OverviewGroup[];
  editors: OverviewGroup[];
  divisions: OverviewGroup[];
  articles: OverviewArticle[];
}
