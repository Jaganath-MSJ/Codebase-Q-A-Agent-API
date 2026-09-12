/**
 * Minimal glob matcher for repo-relative, forward-slash paths: `**` matches
 * any number of path segments (including zero), `*` matches within one
 * segment, `?` matches one character. No brace expansion, no negation — the
 * fraction of glob syntax `list_files` actually needs.
 *
 * Implemented as a linear-time (O(path.length · pattern.length)) dynamic
 * program rather than by compiling to a RegExp on purpose: a regex built by
 * concatenating one `[^/]*` per `*` backtracks catastrophically on a
 * `*`-heavy, non-matching input, and `list_files`'s pattern is chosen by the
 * (model-driven, attacker-influenceable) tool caller — so a pathological glob
 * could hang the single-threaded event loop for minutes. The DP below has no
 * backtracking, so worst-case cost stays linear in path × pattern length.
 */
type Token =
  | { kind: 'lit'; ch: string }
  | { kind: 'question' } // exactly one non-'/' character
  | { kind: 'star' } // any run of non-'/' characters (within one segment)
  | { kind: 'globstar' }; // any run of characters, including '/'

function tokenize(pattern: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '*' && pattern[i + 1] === '*') {
      tokens.push({ kind: 'globstar' });
      i += 2;
      if (pattern[i] === '/') i++; // so "**/x" also matches "x" at the root
    } else if (c === '*') {
      tokens.push({ kind: 'star' });
      i++;
    } else if (c === '?') {
      tokens.push({ kind: 'question' });
      i++;
    } else {
      tokens.push({ kind: 'lit', ch: c });
      i++;
    }
  }
  return tokens;
}

export function matchesGlob(path: string, pattern: string): boolean {
  const tokens = tokenize(pattern);
  const n = path.length;
  const m = tokens.length;

  // dp[j] answers "does path.slice(i) match tokens.slice(j)?" for the current
  // row i. We sweep i from the end of the path back to the start; `next` holds
  // row i+1, `curr` the row being filled. Each cell reads only same-row-higher-j
  // and next-row cells, so two rolling rows suffice.
  let next = new Array<boolean>(m + 1).fill(false);
  next[m] = true; // the empty path matches the empty pattern
  for (let j = m - 1; j >= 0; j--) {
    // The empty path still matches a trailing run of stars (each matching zero).
    const t = tokens[j]!;
    next[j] = (t.kind === 'star' || t.kind === 'globstar') && next[j + 1]!;
  }

  for (let i = n - 1; i >= 0; i--) {
    const curr = new Array<boolean>(m + 1).fill(false); // curr[m]: non-empty path never matches empty pattern
    const ch = path[i]!;
    for (let j = m - 1; j >= 0; j--) {
      const t = tokens[j]!;
      switch (t.kind) {
        case 'lit':
          curr[j] = ch === t.ch && next[j + 1]!;
          break;
        case 'question':
          curr[j] = ch !== '/' && next[j + 1]!;
          break;
        case 'star':
          // match zero chars (advance the pattern) or consume one non-'/' char
          curr[j] = curr[j + 1]! || (ch !== '/' && next[j]!);
          break;
        case 'globstar':
          // match zero chars or consume one char of any kind
          curr[j] = curr[j + 1]! || next[j]!;
          break;
      }
    }
    next = curr;
  }

  return next[0]!;
}
