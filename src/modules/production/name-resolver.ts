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
  const floaters = roster.filter((r) => r.floats).map((r) => r.name).filter(Boolean);
  for (const division of divisions) {
    perDivision.set(
      division,
      buildDivisionResolver(
        [
          ...roster.filter((r) => r.division === division).map((r) => r.name).filter(Boolean),
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

  return (name: string, division: string): string => {
    const fn = perDivision.get(division);
    const resolved = fn ? fn(name) : name;
    return canonicalCase.get(resolved.toLowerCase()) ?? resolved;
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
    n.toLowerCase().split(/[\s.]+/).filter(Boolean);

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
          ? [...fulls.values()][0]           // "Khosalu" → "Khosalu Puro"
          : displayByKey.get(low) ?? name);
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
