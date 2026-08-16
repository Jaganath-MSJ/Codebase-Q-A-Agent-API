const SPECIAL_RE = /[.+^${}()|[\]\\]/;

/**
 * Minimal glob matcher for repo-relative, forward-slash paths: `**` matches
 * any number of path segments (including zero), `*` matches within one
 * segment, `?` matches one character. No brace expansion, no negation — the
 * fraction of glob syntax `list_files` actually needs.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  let regex = '^';
  let i = 0;

  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '*' && pattern[i + 1] === '*') {
      regex += '.*';
      i += 2;
      if (pattern[i] === '/') i++; // so "**/x" also matches "x" at the root
    } else if (c === '*') {
      regex += '[^/]*';
      i++;
    } else if (c === '?') {
      regex += '[^/]';
      i++;
    } else {
      regex += SPECIAL_RE.test(c) ? `\\${c}` : c;
      i++;
    }
  }

  return new RegExp(`${regex}$`).test(path);
}
