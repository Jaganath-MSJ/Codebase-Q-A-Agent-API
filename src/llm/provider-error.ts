import type { ChatRequest } from './chat-provider.interface';

/**
 * Turning raw provider failures into something a user should see, and deciding
 * whether a failover is worth attempting at all.
 *
 * Pure — no I/O, no clock — so both are unit-testable against the real vendor
 * error shapes rather than against a mock of our own design.
 *
 * Neither the Groq (OpenAI-SDK) nor the Gemini (@google/genai) client
 * normalises its errors, so the shapes below are inspected directly, the same
 * way `isRetriableProviderError` in `failover.ts` does.
 */

export type ProviderErrorKind =
  'rate_limited' | 'unavailable' | 'too_large' | 'auth' | 'unknown';

function statusesOf(err: Record<string, unknown>): unknown[] {
  const obj = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  return [
    err.status,
    err.statusCode,
    err.code,
    obj(err.response).status,
    obj(err.error).code,
    obj(err.error).status,
  ];
}

const has = (statuses: unknown[], code: number) =>
  statuses.some((s) => s === code || s === String(code));

/**
 * Classifies a provider failure. Returns `null` when the error does not look
 * like one at all — a database fault or a bug in our own code must NOT be
 * dressed up as "the model is busy", which would hide real defects behind a
 * reassuring message.
 */
export function classifyProviderError(err: unknown): ProviderErrorKind | null {
  if (err === null || typeof err !== 'object') return null;
  const e = err as Record<string, unknown>;
  const statuses = statusesOf(e);
  const message = typeof e.message === 'string' ? e.message : '';

  if (has(statuses, 429) || /\bRESOURCE_EXHAUSTED\b/.test(message)) {
    return 'rate_limited';
  }
  if (has(statuses, 503) || /\bUNAVAILABLE\b/.test(message)) {
    return 'unavailable';
  }
  if (
    has(statuses, 413) ||
    /\b(context length|too large|maximum context)\b/i.test(message)
  ) {
    return 'too_large';
  }
  if (has(statuses, 401) || has(statuses, 403)) return 'auth';

  // Message-only fallbacks, deliberately requiring a qualifying word alongside
  // the number so an unrelated "429" inside some other string does not match.
  if (
    /\b429\b/.test(message) &&
    /(quota|rate.?limit|too many requests)/i.test(message)
  ) {
    return 'rate_limited';
  }
  if (
    /\b503\b/.test(message) &&
    /(unavailable|overloaded|service)/i.test(message)
  ) {
    return 'unavailable';
  }
  return null;
}

/**
 * DEF-028. The message a user should actually read.
 *
 * Returns `null` for anything that is not a recognised provider condition, so
 * the caller keeps its existing handling rather than flattening every failure
 * into the same reassuring sentence.
 *
 * What these deliberately do NOT contain: the vendor's name, its billing or
 * upgrade links, the organisation identifier, the model id, or any JSON. A user
 * of this app cannot act on a third party's upsell, and an internal org id is
 * not theirs to see. The raw text still goes to the server log, where it is
 * useful.
 */
export function userFacingProviderMessage(err: unknown): string | null {
  switch (classifyProviderError(err)) {
    case 'rate_limited':
      return 'The model is rate-limited right now (free-tier quota). Wait a moment and ask again.';
    case 'unavailable':
      return 'The model is temporarily unavailable. Wait a moment and ask again.';
    case 'too_large':
      return 'This question needed more context than the model would accept. Try asking something narrower, or about fewer files.';
    case 'auth':
      return 'The model provider rejected the request. Check the API key in the server configuration.';
    case 'unknown':
    case null:
      return null;
  }
}

/**
 * A rough token count for a request, used only to decide whether a failover is
 * worth attempting.
 *
 * Four characters per token is the usual English/code approximation. It is not
 * exact and does not need to be: it is compared against a budget to answer
 * "obviously too big?", and the margin in `fitsWithinBudget` absorbs the error.
 * Nothing is billed or truncated based on this number.
 */
export function estimateRequestTokens(req: ChatRequest): number {
  const toolText = (req.tools ?? [])
    .map((t) => `${t.name}${t.description}${JSON.stringify(t.parameters)}`)
    .join('');

  // DEF-034. The accumulated agent-loop history. Omitting it made every step of
  // a multi-step request score the same as its first, even though this is the
  // part that actually grows — and grows fastest.
  //
  // Latent rather than live today: only `agent.loop.ts` populates `priorTurns`,
  // and it always sends `tools`, which `canFailOver` already refuses for a
  // `supportsTools: false` secondary. Counted anyway, because the day a
  // tools-capable secondary is configured, this becomes the dominant term and
  // nothing would flag it.
  const historyText = (req.priorTurns ?? [])
    .map((turn) =>
      turn.role === 'assistant'
        ? turn.content +
          turn.toolCalls
            .map((c) => `${c.name}${JSON.stringify(c.args)}`)
            .join('')
        : turn.results.map((r) => `${r.name}${r.content}`).join(''),
    )
    .join('');

  const chars =
    req.system.length + req.user.length + toolText.length + historyText.length;

  // DEF-034. A tokens-per-minute ceiling is charged for input *and* output, so
  // the allowance we are about to ask for is part of what has to fit. Added as
  // tokens, not characters: `maxTokens` is already a token count.
  return Math.ceil(chars / 4) + (req.maxTokens ?? 0);
}

/**
 * DEF-029. Would this request fit inside a provider's per-request budget?
 *
 * `budget` is a provider's `maxRequestTokens` — the free-tier tokens-per-minute
 * ceiling, which is NOT the same thing as the model's context window and is
 * usually far smaller. A provider that does not declare one is treated as
 * unconstrained.
 *
 * The 10% headroom is deliberate: the estimate above is approximate, and the
 * cost of a false "fits" is a wasted call that fails anyway, while a false
 * "does not fit" silently skips a failover that would have worked. Erring
 * toward attempting is the cheaper mistake.
 */
export function fitsWithinBudget(
  req: ChatRequest,
  budget: number | undefined,
): boolean {
  if (budget === undefined) return true;
  return estimateRequestTokens(req) <= budget * 1.1;
}
