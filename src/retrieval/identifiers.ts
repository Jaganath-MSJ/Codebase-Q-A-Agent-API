// Tokenizes on letter-case/digit boundaries, acronym-aware: a run of capitals
// immediately followed by a Capital+lowercase pair breaks before that pair
// (XMLHttpRequest -> XML | Http | Request), a trailing capital run with no
// following lowercase stays whole (userID -> user | ID), everything else is
// an optional leading capital plus a lowercase run, or a digit run.
const WORD_RE = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+/g;

/** Splits every identifier-shaped run in `text` into its component words. */
export function splitIdentifiers(text: string): string {
  return (text.match(WORD_RE) ?? []).join(' ');
}

/** Chunk content plus its identifier-split form, for full-text search. */
export function buildSearchText(content: string): string {
  return `${content}\n${splitIdentifiers(content)}`;
}

// Catches camelCase (getUserByEmail), SCREAMING_SNAKE_CASE (RATE_LIMIT_MS),
// and a method-call shape (service.method(). Used to decide whether a
// question mentions a specific identifier at all — the trigram arm is only
// useful (and only adds noise otherwise) when it does.
const IDENTIFIER_TOKEN_RE = /\b[a-z]+[A-Z]\w*|\b[A-Z_]{3,}\b|\b\w+\.\w+\(/g;

/** Extracts identifier-shaped tokens from a question, deduplicated. */
export function extractIdentifierTokens(text: string): string[] {
  return [...new Set(text.match(IDENTIFIER_TOKEN_RE) ?? [])];
}
