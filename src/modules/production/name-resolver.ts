// Name canonicalisation, shared by the production dashboards and the
// resources board so every per-person number agrees on who a name refers to.
//
// The source sheets record the same person as "Dhruv", "Dhruv Singh" and
// occasionally a misspelling, which fragments every per-person total. The
// resolver below collapses those to one identity and MUST be applied by every
// per-person aggregation — a table that skips it will silently disagree with
// the headline numbers.

/** Canonicalises a person's name within a division. */
export type NameResolver = (name: string, division: string) => string;

/** A listed person, as the resolver needs them. */
export interface ResolverPerson {
  division: string;
  name: string;
  /** Works across every division (Associates, the newsroom). */
  floats?: boolean;
}

/** The name-bearing fields of a piece, from any pipeline. */
export interface NamedPiece {
  division: string;
  writer: string;
  editor: string;
  editor2?: string;
  allottedBy: string;
}

export function buildNameResolver(
  roster: ResolverPerson[],
  pieces: NamedPiece[],
): NameResolver {
  // Resolution is scoped to a division. Two divisions routinely staff people
  // who share a first name — NASCAR's "Dhruv" is not NFL's "Dhruv Singh" —
  // so merging across divisions would fuse two real people into one.
  const divisions = new Set<string>([
    ...roster.map((r) => r.division),
    ...pieces.map((p) => p.division),
  ]);
  const perDivision = new Map<string, (n: string) => string>();
  // Floaters (Associates, the newsroom) are listed once, under their pool, but
  // work in every division — so their spelling is offered to every division's
  // resolver, which is what turns content's "Rati" into "Rati Agrawal".
  const floaters = roster
    .filter((r) => r.floats)
    .map((r) => r.name)
    .filter(Boolean);
  for (const division of divisions) {
    perDivision.set(
      division,
      buildDivisionResolver(
        [
          ...roster
            .filter((r) => r.division === division)
            .map((r) => r.name)
            .filter(Boolean),
          ...floaters,
        ],
        pieces.filter((p) => p.division === division),
      ),
    );
  }

  // Names differing only in capitalisation ("aadesh" / "Aadesh") are the same
  // person even across divisions — unlike a shared first name, an exact match
  // ignoring case carries no ambiguity. Folded globally, after the
  // division-scoped pass, so one editor working two divisions appears once.
  const rosterSpelling = new Map<string, string>();
  for (const r of roster) {
    const low = r.name.toLowerCase();
    if (!rosterSpelling.has(low)) rosterSpelling.set(low, r.name);
  }
  const caseFreq = new Map<string, number>();
  const seenResolved = new Set<string>();
  for (const p of pieces) {
    const fn = perDivision.get(p.division);
    if (!fn) continue;
    for (const raw of [p.writer, p.editor, p.editor2 ?? '', p.allottedBy]) {
      if (!raw || raw === 'Unknown') continue;
      const resolved = fn(raw);
      seenResolved.add(resolved);
      caseFreq.set(resolved, (caseFreq.get(resolved) ?? 0) + 1);
    }
  }
  const canonicalCase = new Map<string, string>();
  for (const n of seenResolved) {
    const low = n.toLowerCase();
    const roster = rosterSpelling.get(low);
    if (roster) {
      canonicalCase.set(low, roster);
      continue;
    }
    const cur = canonicalCase.get(low);
    if (!cur) {
      canonicalCase.set(low, n);
      continue;
    }
    const fn = caseFreq.get(n) ?? 0;
    const fc = caseFreq.get(cur) ?? 0;
    const preferN =
      fn > fc || (fn === fc && /^[A-Z]/.test(n) && !/^[A-Z]/.test(cur));
    if (preferN) canonicalCase.set(low, n);
  }

  const toRoster = buildRosterMatcher(roster);
  const cache = new Map<string, string>();
  return (name: string, division: string): string => {
    const key = `${division}|${name}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const fn = perDivision.get(division);
    const resolved = fn ? fn(name) : name;
    const cased = canonicalCase.get(resolved.toLowerCase()) ?? resolved;
    const out = rosterSpelling.has(cased.toLowerCase())
      ? cased
      : (toRoster(cased, division) ?? cased);
    cache.set(key, out);
    return out;
  };
}

/** False for notes typed into a name column ("legal approval needed", "sch for 16.30"). */
export function isPersonName(name: string): boolean {
  return (
    /[a-z]/i.test(name) &&
    !/\d/.test(name) &&
    !/\b(approval|needed|changed|tweaked|pending|title|tbd|forwarded|rewrite|waiting|updated|scheduled|sch|published|verified|verifying|scrapped|hold|rework)\b/i.test(
      name,
    )
  );
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let left = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = Math.min(
        prev[j] + 1,
        left + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev[j - 1] = left;
      left = cur;
    }
    prev[b.length] = left;
  }
  return prev[b.length];
}

/**
 * The second pass, for a name the division's own resolver could not place on
 * the roster. The roster is now the whole team, but the content still names
 * people outside their listed vertical (a Tennis producer writing NBA), by a
 * shortened or embellished name ("Hetal Moleshri" for Hetal Rajesh Moleshri,
 * "Bhwya Sriya" for Bhwya), by surname alone ("Emmanuel"), or misspelt
 * ("Carolina John").
 *
 * Tiers run from the most to the least specific and the first tier with any
 * candidate decides. Within it, people listed under the piece's division (or
 * floating) win; anything still ambiguous stays unmatched — NASCAR's "Dhruv"
 * is neither NFL Dhruv, and a guess would fuse two real people.
 */
function buildRosterMatcher(
  roster: ResolverPerson[],
): (name: string, division: string) => string | null {
  const tokensOf = (n: string): string[] =>
    n
      .toLowerCase()
      .split(/[\s.]+/)
      .filter(Boolean);
  const byName = new Map<
    string,
    { name: string; t: string[]; divisions: Set<string>; floats: boolean }
  >();
  for (const r of roster) {
    const low = r.name.toLowerCase();
    const p = byName.get(low) ?? {
      name: r.name,
      t: tokensOf(r.name),
      divisions: new Set<string>(),
      floats: false,
    };
    p.divisions.add(r.division);
    p.floats ||= !!r.floats;
    byName.set(low, p);
  }
  const people = [...byName.values()].filter((p) => p.t.length);
  type P = (typeof people)[number];

  const close = (a: string, b: string) =>
    a === b || (a.length >= 5 && b.length >= 5 && editDistance(a, b) <= 1);
  // "Utsav S" names Utsav Sinha, not Utsav Gupta.
  const initialsFit = (initials: string[], p: P) =>
    initials.every((i) => p.t.slice(1).some((tok) => tok[0] === i));

  return (name: string, division: string): string | null => {
    const t = tokensOf(name);
    if (!t.length || !isPersonName(name)) return null;
    const words = t.filter((x) => x.length > 1);
    if (!words.length) return null;
    const initials = t.slice(1).filter((x) => x.length === 1);
    const first = t[0];
    const last = words[words.length - 1];
    const single = words.length === 1;

    const tiers: ((p: P) => boolean)[] = [
      (p) => p.t.join(' ') === t.join(' '),
      // Same first name, one name's words all inside the other's: a dropped
      // middle name, a dropped surname, or an initial written out.
      (p) =>
        !single &&
        p.t[0] === first &&
        (words.every((w) => p.t.includes(w)) ||
          (p.t.length > 1 && p.t.every((w) => t.includes(w)))),
      // Typos in a full name — before the bare-first-name tier, so "Krishna
      // Prasad Pattnaik" is Krushna, not NBA's Krishna. A long surname under
      // the same first name may differ by two ("Aggarwal" / "Agrawal").
      (p) => {
        if (single) return false;
        const pl = p.t[p.t.length - 1];
        return (
          (close(p.t[0], first) && close(pl, last)) ||
          (p.t[0] === first && last.length >= 7 && editDistance(pl, last) <= 2)
        );
      },
      // The roster lists a bare first name; the content adds a surname.
      (p) => !single && p.t.length === 1 && p.t[0] === first,
      (p) => single && p.t[0] === first && initialsFit(initials, p),
      // Surname or middle name used alone.
      (p) => single && first.length >= 4 && p.t.slice(1).includes(first),
      (p) => single && close(p.t[0], first) && initialsFit(initials, p),
      (p) =>
        single &&
        first.length >= 5 &&
        p.t.slice(1).some((tok) => close(tok, first)),
      // A nickname that starts the first name ("Surya" for Suryakant), only
      // inside the person's own division.
      (p) =>
        single &&
        first.length >= 4 &&
        p.t[0].startsWith(first) &&
        p.divisions.has(division),
    ];
    for (const fits of tiers) {
      const hits = people.filter(fits);
      if (!hits.length) continue;
      const local = hits.filter((p) => p.divisions.has(division));
      const pool = local.length
        ? local
        : hits.filter((p) => p.floats).length
          ? hits.filter((p) => p.floats)
          : hits;
      return pool.length === 1 ? pool[0].name : null;
    }
    return null;
  };
}

function buildDivisionResolver(
  rosterNames: string[],
  pieces: NamedPiece[],
): (n: string) => string {
  // Raw name → how often it appears, used to pick the winning spelling when
  // the only difference is capitalisation ("aadesh" vs "Aadesh").
  const freq = new Map<string, number>();
  const bump = (n: string) => {
    if (!n || n === 'Unknown') return;
    freq.set(n, (freq.get(n) ?? 0) + 1);
  };
  for (const p of pieces) {
    bump(p.writer);
    bump(p.editor);
    bump(p.editor2 ?? '');
    bump(p.allottedBy);
  }
  const dataNames = [...freq.keys()];

  // "Archana.R" and "Archana" are the same person, so an initial glued on
  // with a dot tokenises the same way a space would.
  const tokensOf = (n: string): string[] =>
    n
      .toLowerCase()
      .split(/[\s.]+/)
      .filter(Boolean);

  const rosterByLower = new Map<string, string>();
  for (const n of rosterNames) {
    const low = n.toLowerCase();
    if (!rosterByLower.has(low)) rosterByLower.set(low, n);
  }

  // Roster people recorded under a single name ("Himanga", "Archana"): that
  // spelling is the official one and wins over any longer data variant.
  const rosterSingle = new Map<string, string>();
  for (const n of rosterNames) {
    const t = tokensOf(n);
    if (t.length === 1 && !rosterSingle.has(t[0])) rosterSingle.set(t[0], n);
  }

  // The sheets mix a person's full name with an abbreviation: a bare first
  // name ("Khosalu"), or a first name plus an initial ("Utsav S",
  // "Archana.R"). Neither form identifies a person on its own, so both count
  // as stubs that expand to the one full name sharing their first token.
  // Where two people share a first name ("Utsav Sinha" and "Utsav Jain") no
  // expansion is safe and the identities stay separate.
  const isStub = (t: string[]): boolean =>
    t.length < 2 || t.some((tok) => tok.length < 2);

  const fullByFirst = new Map<string, Map<string, string>>();
  const addFull = (n: string, preferred: boolean) => {
    const t = tokensOf(n);
    if (isStub(t)) return; // stubs do not define an identity
    const key = t.join(' ');
    if (!fullByFirst.has(t[0])) fullByFirst.set(t[0], new Map());
    const m = fullByFirst.get(t[0])!;
    if (preferred || !m.has(key)) m.set(key, n);
  };
  for (const n of rosterNames) addFull(n, true);
  for (const n of dataNames) addFull(n, false);

  // Case-only variants collapse onto the roster spelling, else the commonest.
  // A capitalised spelling beats an all-lowercase one at equal frequency, so
  // the merged identity still displays like a name.
  const displayByKey = new Map<string, string>();
  const better = (a: string, b: string): boolean => {
    const fa = freq.get(a) ?? 0;
    const fb = freq.get(b) ?? 0;
    if (fa !== fb) return fa > fb;
    const ca = /^[A-Z]/.test(a);
    const cb = /^[A-Z]/.test(b);
    return ca && !cb;
  };
  for (const n of dataNames) {
    const low = n.toLowerCase();
    const roster = rosterByLower.get(low);
    if (roster) {
      displayByKey.set(low, roster);
      continue;
    }
    const cur = displayByKey.get(low);
    if (!cur || better(n, cur)) displayByKey.set(low, n);
  }

  const cache = new Map<string, string>();
  return (name: string): string => {
    if (!name || name === 'Unknown' || name === 'Unassigned') return name;
    const hit = cache.get(name);
    if (hit) return hit;

    const low = name.toLowerCase();
    const t = tokensOf(name);
    let out: string;

    if (rosterByLower.has(low)) {
      out = rosterByLower.get(low)!;
    } else if (isStub(t)) {
      // The roster spelling wins when the person is listed under a single
      // name, so "Suryakant" and "Suryakant Das" both land on "Suryakant"
      // rather than pulling in opposite directions.
      const fulls = fullByFirst.get(t[0]);
      out =
        rosterSingle.get(t[0]) ??
        (fulls && fulls.size === 1
          ? [...fulls.values()][0] // "Khosalu" → "Khosalu Puro"
          : (displayByKey.get(low) ?? name));
    } else {
      const fulls = fullByFirst.get(t[0]);
      // A rostered single name plus at most one longer variant means the
      // longer one is a data embellishment ("Suryakant Das" → "Suryakant").
      if (rosterSingle.has(t[0]) && (!fulls || fulls.size === 1)) {
        out = rosterSingle.get(t[0])!;
      } else if (fulls && fulls.size === 1) {
        out = [...fulls.values()][0];
      } else {
        out = displayByKey.get(low) ?? name;
      }
    }

    cache.set(name, out);
    return out;
  };
}
