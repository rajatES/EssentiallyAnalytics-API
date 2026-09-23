import { clean } from '../production/normalization';

export interface DivisionRef {
  division: string;
  subFeed: string;
}

/**
 * Division labels as the managers and the Yahoo sheet write them, mapped onto
 * the Critical Flow content divisions — the one vocabulary the resources board
 * speaks. Tennis and Olympics are the two halves of US Sports and keep their
 * sub-feed so quotas can meet the matching "(Tennis)" / "(Olympics)" month tabs.
 *
 * Keep in step with DIVISION_ALIASES in n8n/critical-flow/src/07-resources-transform.js,
 * which places people with the same map.
 */
const DIVISION_ALIASES: [RegExp, string, string][] = [
  [/^nfl( active)?$/, 'NFL', ''],
  [/^(cfb|college football)$/, 'College Football', ''],
  [/^nascar$/, 'NASCAR', ''],
  [/^nba( active| legends)?$/, 'NBA', ''],
  [/^wnba(\s*\/\s*ncaa)?$/, 'WNBA', ''],
  [/^(ufc|combat|boxing)$/, 'UFC', ''],
  [/^golf$/, 'Golf', ''],
  [/^tennis$/, 'US Sports', 'Tennis'],
  [/^olympics$/, 'US Sports', 'Olympics'],
  [/^(uss|us sports|us sports \+ olympics|uss\s*\/\s*tennis)$/, 'US Sports', ''],
  [/^mlb$/, 'MLB', ''],
  [/^associates?$/, 'Associate', ''],
  [/^(newsroom|nr)( le| lead| editor)?$/, 'Newsroom', ''],
  [/^basketball\s*news$/, 'Basketball News', ''],
];

/** Pools whose people float across every division rather than owning one. */
export const FLOAT_POOLS = new Set(['Associate', 'Newsroom']);

function stripPodSuffix(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s*[-–]\s*pod\s*$/, '')
    .replace(/\s*\(pod\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function aliasOne(raw: string): DivisionRef | null {
  const key = stripPodSuffix(raw);
  if (!key) return null;
  for (const [re, division, subFeed] of DIVISION_ALIASES) {
    if (re.test(key)) return { division, subFeed };
  }
  return null;
}

/**
 * One cell may name several divisions ("NFL/CFB"). The whole string is tried
 * first so labels that legitimately contain a slash ("WNBA/NCAA") stay whole.
 */
export function parseDivisions(raw: any): DivisionRef[] {
  const s = clean(raw);
  if (!s) return [];
  const whole = aliasOne(s);
  if (whole) return [whole];
  const out: DivisionRef[] = [];
  for (const part of s.split('/')) {
    const ref = aliasOne(part);
    if (ref && !out.some((o) => o.division === ref.division && o.subFeed === ref.subFeed)) {
      out.push(ref);
    }
  }
  return out;
}

/** A pipeline's division label in board terms; unknown labels pass through. */
export function canonicalDivision(label: string): DivisionRef {
  return parseDivisions(label)[0] ?? { division: clean(label) || 'Unknown', subFeed: '' };
}

/** Whether a person placed at `person` belongs to content labelled `label`. */
export function coversLabel(person: DivisionRef, label: string): boolean {
  const ref = canonicalDivision(label);
  if (ref.division !== person.division) return false;
  return !ref.subFeed || !person.subFeed || ref.subFeed === person.subFeed;
}
