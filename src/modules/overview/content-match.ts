/**
 * Matches production pieces to the article pages social traffic landed on.
 *
 * Nothing links the two directly: the sheets record a WordPress edit link
 * (`post.php?post=…`), the traffic warehouse a public path. What they share is
 * the headline, because an essentiallysports.com slug is the headline,
 * lower-cased and hyphenated behind a section prefix (`/nfl-active-news-…/`).
 * Editors reword headlines on the way to publishing, so the comparison is
 * fuzzy: word overlap, each word weighted by how rare it is across all slugs,
 * so names carry a match and template words ("who", "wife", "everything") do
 * not. Measured on October 2026: two-thirds of CF and Yahoo publications
 * matched; the rest drew no social landings at all.
 */

const NUMBER_WORDS = new Set(
  (
    'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen ' +
    'sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety ' +
    'hundred thousand million billion'
  ).split(' '),
);

/** Below this a headline is too short to identify one article. */
const MIN_TOKENS = 4;
/** Weighted similarity a match needs. Under 0.5 it starts pairing different stories. */
const MIN_SCORE = 0.5;
/** How far the best page must lead the next different story, or it is ambiguous. */
const MARGIN = 0.1;
/** Two slugs this alike are one story whose slug was changed, not two candidates. */
const SAME_STORY = 0.7;
/** A page's first social landing must fall this close to the piece's publication date. */
const FIRST_LANDING_WINDOW = { before: 1, after: 3 };

function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'‘`]/g, '');
}

// Slugs spell numbers out inconsistently ("twenty-six-year-old", "4-times",
// "100m"), so digits and number words are dropped from both sides.
const meaningful = (w: string) => !!w && !/^\d+$/.test(w) && !NUMBER_WORDS.has(w);

export function headlineTokens(title: string): string[] {
  return [...new Set(normalize(title).split(/[^a-z0-9]+/).filter(meaningful))];
}

function slugTokens(slug: string): string[] {
  let words = normalize(slug).split(/[^a-z0-9]+/).filter(Boolean);
  const prefixEnd = words.indexOf('news');
  if (prefixEnd >= 0 && prefixEnd <= 4) words = words.slice(prefixEnd + 1);
  // WordPress turns a possessive's apostrophe into a hyphen on some posts
  // ("evloev-s-hijab") and drops it on others ("freemans").
  const out: string[] = [];
  for (const w of words) {
    if (w === 's' && out.length) out[out.length - 1] += 's';
    else out.push(w);
  }
  return [...new Set(out.filter(meaningful))];
}

/**
 * The article a landing path belongs to — its first segment, so `/slug/amp/`
 * and `/slug/2/` count with `/slug/` — or null for anything that is not an
 * article (home, `/join/…`, `/stories/…`, section fronts).
 */
export function articleSlug(pagePath: string): string | null {
  let first: string;
  try {
    first = decodeURIComponent(pagePath).split('/').filter(Boolean)[0] ?? '';
  } catch {
    return null;
  }
  return slugTokens(first).length >= MIN_TOKENS ? first : null;
}

function shiftDay(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface IndexedSlug {
  slug: string;
  firstDay: string;
  tokens: string[];
  set: Set<string>;
}

export interface SlugMatch {
  /** Usually one; more when the article's slug was changed after it went out. */
  slugs: string[];
  score: number;
}

export class SlugMatcher {
  private readonly byToken = new Map<string, IndexedSlug[]>();
  private readonly size: number;

  /** `firstDay` is each slug's earliest social landing in the traffic loaded. */
  constructor(slugs: { slug: string; firstDay: string }[]) {
    for (const { slug, firstDay } of slugs) {
      const tokens = slugTokens(slug);
      const entry = { slug, firstDay, tokens, set: new Set(tokens) };
      for (const w of entry.set) {
        if (!this.byToken.has(w)) this.byToken.set(w, []);
        this.byToken.get(w)!.push(entry);
      }
    }
    this.size = slugs.length;
  }

  private weight(word: string): number {
    return Math.log((this.size + 1) / ((this.byToken.get(word)?.length ?? 0) + 0.5));
  }

  private similarity(tokens: string[], other: IndexedSlug): number {
    let shared = 0;
    let a = 0;
    let b = 0;
    for (const w of tokens) {
      const x = this.weight(w);
      a += x;
      if (other.set.has(w)) shared += x;
    }
    for (const w of other.tokens) b += this.weight(w);
    return a + b > 0 ? (2 * shared) / (a + b) : 0;
  }

  match(title: string, publishedDay: string): SlugMatch | null {
    const tokens = headlineTokens(title);
    if (tokens.length < MIN_TOKENS) return null;

    // Traffic before publication belongs to an older article on the same story;
    // a page whose first landing is long after was not this piece's posting.
    const from = shiftDay(publishedDay, -FIRST_LANDING_WINDOW.before);
    const to = shiftDay(publishedDay, FIRST_LANDING_WINDOW.after);
    const candidates = new Set<IndexedSlug>();
    for (const w of tokens) {
      for (const s of this.byToken.get(w) ?? []) {
        if (s.firstDay >= from && s.firstDay <= to) candidates.add(s);
      }
    }

    const scored = [...candidates]
      .map((s) => ({ s, score: this.similarity(tokens, s) }))
      .sort((x, y) => y.score - x.score);
    const best = scored[0];
    if (!best || best.score < MIN_SCORE) return null;

    const sameStory = scored.filter(
      (c) => c === best || (c.score >= MIN_SCORE && this.similarity(best.s.tokens, c.s) >= SAME_STORY),
    );
    const runnerUp = scored.find((c) => !sameStory.includes(c));
    if (runnerUp && best.score - runnerUp.score < MARGIN) return null;

    return { slugs: sameStory.map((c) => c.s.slug), score: best.score };
  }
}
