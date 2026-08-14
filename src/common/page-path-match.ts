/**
 * Glob matching for landing-page mappings.
 *
 * UTM mappings key off `utm_medium`, an exact token. Landing pages can't work
 * that way — there are thousands of article URLs and new ones every day — so a
 * mapping matches a *pattern* instead: '/wnba-*' claims every WNBA article.
 *
 * Only '*' is special (it matches any run of characters, including '/'), so
 * patterns stay readable for non-technical editors. Everything else is literal.
 */

export interface PathMappingLike {
  id?: number;
  pattern: string;
  pageName: string;
  category: string;
  team?: string | null;
  /** Higher wins when several patterns match. Ties break on specificity. */
  priority?: number;
}

export interface CompiledPathMapping<T extends PathMappingLike = PathMappingLike> {
  mapping: T;
  regex: RegExp;
  /** Literal (non-wildcard) character count — the specificity tie-breaker. */
  weight: number;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function compilePathMappings<T extends PathMappingLike>(
  mappings: T[],
): CompiledPathMapping<T>[] {
  return mappings
    .filter((m) => m && typeof m.pattern === 'string' && m.pattern.trim())
    .map((m) => ({
      mapping: m,
      regex: globToRegExp(m.pattern),
      weight: m.pattern.replace(/\*/g, '').length,
    }))
    // Most specific first, so the first match wins and callers can stop early.
    .sort((a, b) => {
      const pa = a.mapping.priority ?? 0;
      const pb = b.mapping.priority ?? 0;
      if (pa !== pb) return pb - pa;
      return b.weight - a.weight;
    });
}

export function matchPagePath<T extends PathMappingLike>(
  path: string,
  compiled: CompiledPathMapping<T>[],
): T | undefined {
  if (!path) return undefined;
  const candidate = path.trim();
  for (const c of compiled) {
    if (c.regex.test(candidate)) return c.mapping;
  }
  return undefined;
}
