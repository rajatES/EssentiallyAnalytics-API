/**
 * Single source of truth for "given what we know about an account, what URL
 * does a reader click through to?".
 *
 * Three dashboards name the same social accounts from three different tables,
 * and each table knows a different amount about them:
 *
 *   revenue_mappings   pageId   — a Meta Page ID, resolvable on its own
 *   social_profiles    profileId + platform (+ username for Instagram)
 *   page_mappings      pageName only — keyed on utm_medium, no identifier
 *
 * Keeping the URL shapes here means the Traffic / Reports / Revenue pages can
 * never drift into linking the same account three different ways, and adding a
 * platform is one edit rather than three.
 *
 * Mirrored for the browser in ES-Studio-UI/src/lib/page-links.ts — the UI does
 * the actual rendering, so both halves must agree on the URL shapes.
 */

export type PageLinkPlatform =
  | 'facebook'
  | 'instagram'
  | 'threads'
  | 'reddit';

export interface PageLinkInput {
  platform: PageLinkPlatform;
  /** Numeric platform identifier. Only Facebook Page IDs resolve as a URL. */
  id?: string | null;
  /** Vanity handle / username, without the leading '@'. */
  handle?: string | null;
  /** Display name, used for Reddit's 'r/Sub' convention. */
  name?: string | null;
  /** Manually entered URL. Always wins when present. */
  explicitUrl?: string | null;
}

/** Platform labels as they appear in page_mappings.platform / .utmSource. */
const PLATFORM_ALIASES: Record<string, PageLinkPlatform> = {
  fb: 'facebook',
  facebook: 'facebook',
  ig: 'instagram',
  instagram: 'instagram',
  threads: 'threads',
  reddit: 'reddit',
  subreddit: 'reddit',
};

export function toPageLinkPlatform(
  value: string | null | undefined,
): PageLinkPlatform | null {
  return PLATFORM_ALIASES[(value || '').trim().toLowerCase()] ?? null;
}

/**
 * Accept what a human types into the override field and hand back something a
 * browser can open, or null.
 *
 * Bare domains ('facebook.com/ESGolf') get https://. Anything that is not
 * http(s) after that is rejected — the value is rendered straight into an
 * href, so a 'javascript:' or 'data:' URL pasted into the mappings editor
 * would otherwise become a stored XSS vector for every viewer of the page.
 */
export function normalizeExplicitUrl(
  raw: string | null | undefined,
): string | null {
  const value = (raw || '').trim();
  if (!value) return null;

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(value);
  const candidate = hasScheme ? value : `https://${value}`;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // A schemeless value needs a dotted host to be a URL at all. Without this,
    // a bare handle typed into the override field ('essentiallygolf') parses
    // as https://essentiallygolf and is stored as a link that goes nowhere.
    if (!hasScheme && !parsed.hostname.includes('.')) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Strip the decoration a handle picks up in spreadsheets: '@name', 'r/name'. */
function cleanHandle(raw: string | null | undefined): string | null {
  const value = (raw || '').trim().replace(/^@+/, '').replace(/^r\//i, '');
  // A handle has to survive being pasted into a path segment untouched.
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : null;
}

const isNumericId = (value: string) => /^\d+$/.test(value);

/**
 * The URL for one account, or null when we genuinely cannot tell.
 *
 * Returning null rather than a guess is deliberate: a link to the wrong page
 * is worse than no link, and the mappings editors exist to fill these gaps by
 * hand.
 */
export function buildPageUrl(input: PageLinkInput): string | null {
  const explicit = normalizeExplicitUrl(input.explicitUrl);
  if (explicit) return explicit;

  const id = (input.id || '').trim();
  const handle = cleanHandle(input.handle);

  switch (input.platform) {
    case 'facebook':
      // Meta Page IDs resolve directly, which is why Revenue and Reports need
      // no data entry at all.
      if (id && isNumericId(id)) return `https://www.facebook.com/${id}`;
      if (handle) return `https://www.facebook.com/${handle}`;
      return null;

    case 'instagram':
      // An IG Business Account ID is NOT the same number as the one in a
      // profile URL, so unlike Facebook there is no id fallback here.
      return handle ? `https://www.instagram.com/${handle}/` : null;

    case 'threads':
      return handle ? `https://www.threads.com/@${handle}` : null;

    case 'reddit': {
      // Traffic page names follow the source sheet's 'r/Sub' convention. The
      // catch-all rows ('Reddit Organic (referral)') have no subreddit and
      // correctly fall through to null.
      const name = (input.name || '').trim();
      const sub = /^r\//i.test(name) ? cleanHandle(name) : handle;
      return sub ? `https://www.reddit.com/r/${sub}` : null;
    }

    default:
      return null;
  }
}

/**
 * Lookup key for matching a Traffic page name against an account we hold an
 * identifier for.
 *
 * Traffic names are typed by hand into the mappings sheet while Reports and
 * Revenue names come from Meta, so they disagree on case, spacing and
 * punctuation ('ES Golf' / 'es-golf' / 'ESGolf'). Comparing on letters and
 * digits alone bridges that without inventing fuzzier matching that could pair
 * two genuinely different pages.
 */
export function pageNameKey(name: string | null | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
