/**
 * Single source of truth for "which page does this traffic row belong to".
 *
 * A page can post the same link two ways, and the two must be counted apart:
 *
 *   normal   ?utm_source=threads&utm_medium=nascar_fan_page_vintage
 *   autopost ?utm_source=threads&utm_medium=nascar_fan_page_vintage
 *              &utm_campaign=threads&utm_term=autopost
 *
 * `utm_medium` is IDENTICAL in both, so matching on medium alone — which is all
 * this system did until now — collapses the two streams onto one row and labels
 * all of it as normal posts. The campaign is the only stored field that tells
 * them apart (`utm_term` never reaches our warehouse at all).
 *
 * Matching rule, most specific first:
 *   1. (medium, campaign) — a mapping row that names a campaign wins, but only
 *      for that exact campaign.
 *   2. (medium)           — a mapping row with a blank campaign is the
 *      catch-all for every other campaign on that medium.
 *
 * GA4's placeholder campaigns ('(referral)', '(not set)', …) need no special
 * case: they simply fail rule 1 and fall through to rule 2, which is what
 * "normal post" means here.
 *
 * Mirrored in ES-Studio-UI/src/lib/page-mapping-match.ts — keep the two in
 * step, for the same reason traffic-platforms.ts is mirrored.
 */

export interface MappingLike {
  pageName: string;
  category?: string | null;
  team?: string | null;
  platform?: string | null;
  utmMediums: string[];
  utmCampaign?: string | null;
}

export interface ResolvedPage {
  pageName: string;
  category: string;
  team?: string;
  platform?: string;
}

export interface MappingIndex {
  /** keyed 'medium\u0000campaign' */
  specific: Map<string, ResolvedPage>;
  /** keyed 'medium' */
  fallback: Map<string, ResolvedPage>;
}

const norm = (v?: string | null) => (v ?? '').trim().toLowerCase();

/** A campaign value that means "the author left it blank", not a real campaign. */
export function isBlankCampaign(value?: string | null): boolean {
  const v = norm(value);
  return (
    v === '' ||
    v === '(not set)' ||
    v === '(none)' ||
    v === '(referral)' ||
    v === '(direct)' ||
    v === '(organic)'
  );
}

export function buildMappingIndex(mappings: MappingLike[]): MappingIndex {
  const specific = new Map<string, ResolvedPage>();
  const fallback = new Map<string, ResolvedPage>();

  for (const m of mappings) {
    const pageName = (m.pageName || '').trim();
    if (!pageName) continue;

    const resolved: ResolvedPage = {
      pageName,
      category: (m.category || '').trim() || 'Other',
      team: m.team?.trim() || undefined,
      platform: m.platform?.trim() || undefined,
    };

    const campaign = norm(m.utmCampaign);
    for (const raw of m.utmMediums || []) {
      const medium = norm(raw);
      if (!medium) continue;
      if (campaign && !isBlankCampaign(campaign)) {
        specific.set(`${medium}\u0000${campaign}`, resolved);
      } else {
        fallback.set(medium, resolved);
      }
    }
  }

  return { specific, fallback };
}

export function resolveMapping(
  index: MappingIndex,
  medium?: string | null,
  campaign?: string | null,
): ResolvedPage | undefined {
  const m = norm(medium);
  if (!m) return undefined;
  const c = norm(campaign);
  if (c && !isBlankCampaign(c)) {
    const hit = index.specific.get(`${m}\u0000${c}`);
    if (hit) return hit;
  }
  return index.fallback.get(m);
}

/**
 * Split a utm_medium value that has a query-string tail pasted onto it.
 *
 * The mappings form used to accept whatever was pasted, so rows arrived as
 * 'nascar_fan_page_vintage&utm_campaign=threads&utm_term=autopost' — the part
 * of the link *after* `utm_medium=`. That never matched anything, because the
 * stored medium is just the first segment.
 *
 * Also accepts a whole link ('?utm_source=…&utm_medium=x&utm_campaign=y') and
 * a bare medium, so every paste shape a person might use lands correctly.
 *
 * The term is returned for the mapping row's label; nothing matches on it.
 */
export function splitPastedMedium(raw: string): {
  medium: string;
  campaign: string | null;
  term: string | null;
} {
  let value = (raw || '').trim();
  if (!value) return { medium: '', campaign: null, term: null };

  // A full link, or any string that still carries its own utm_medium= key.
  if (value.includes('utm_medium=')) {
    const qs = value.slice(value.indexOf('?') + 1);
    const params = new URLSearchParams(qs.replace(/^[?&]/, ''));
    const medium = params.get('utm_medium');
    if (medium) {
      return {
        medium: medium.trim(),
        campaign: params.get('utm_campaign'),
        term: params.get('utm_term'),
      };
    }
  }

  // The common case: the tail that followed utm_medium=, e.g.
  // 'x&utm_campaign=threads&utm_term=autopost'.
  if (value.includes('&')) {
    const [head, ...rest] = value.split('&');
    const params = new URLSearchParams(rest.join('&'));
    return {
      medium: head.trim(),
      campaign: params.get('utm_campaign'),
      term: params.get('utm_term'),
    };
  }

  return { medium: value, campaign: null, term: null };
}

export interface ParsedTrackingLink {
  source: string | null;
  medium: string;
  campaign: string | null;
  term: string | null;
}

/**
 * Break a whole tracking link into the fields a page mapping needs.
 *
 * Accepts the full link, just its query string ('?utm_source=threads&…'), or
 * the tail that follows 'utm_medium='. Used by the mappings form's Tracking
 * Link box and by the CSV importer's trackingLink column, so a link splits the
 * same way however it arrives. Returns null when no utm_medium can be found.
 */
export function parseTrackingLink(raw: string): ParsedTrackingLink | null {
  // Links copied out of HTML or a chat preview often carry '&amp;' and a
  // '#fragment', neither of which belongs to any utm value.
  const text = (raw || '').trim().replace(/&amp;/gi, '&').split('#')[0];
  if (!/utm_/i.test(text)) return null;

  const { medium, campaign, term } = splitPastedMedium(text);
  if (!medium || medium.includes('=')) return null;

  const query = text.includes('?') ? text.slice(text.indexOf('?') + 1) : text;
  const source = new URLSearchParams(query).get('utm_source');

  return {
    source: source?.trim() || null,
    medium,
    campaign: campaign?.trim() || null,
    term: term?.trim() || null,
  };
}
