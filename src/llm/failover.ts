import type { ChatCompletion, ChatEvent, ChatProvider, ChatRequest } from './chat-provider.interface';

/**
 * Retriable = the provider is temporarily unavailable or quota-limited, not a
 * request-shape/auth/logic error (those must NOT fail over — the secondary
 * would reject them too, and it would mask real bugs). Neither the Groq
 * (OpenAI-SDK) nor the Gemini (@google/genai) provider normalizes its errors,
 * so we inspect the raw shapes: a numeric 429/503 status on any of the usual
 * fields, or Gemini's gRPC-style RESOURCE_EXHAUSTED / UNAVAILABLE status names.
 */
export function isRetriableProviderError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  const obj = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

  const statuses = [
    e.status,
    e.statusCode,
    e.code,
    obj(e.response).status,
    obj(e.error).code,
    obj(e.error).status,
  ];
  for (const s of statuses) {
    if (s === 429 || s === 503 || s === '429' || s === '503') return true;
  }

  const msg = typeof e.message === 'string' ? e.message : '';
  if (/\b(RESOURCE_EXHAUSTED|UNAVAILABLE)\b/.test(msg)) return true;
  // Some Gemini/Groq errors carry only the numeric code inside the message
  // text; require a quota/availability word alongside it to avoid matching an
  // unrelated "429" that happens to appear in an error string.
  if (
    /\b(429|503)\b/.test(msg) &&
    /(quota|rate limit|exhaust|unavailable|overloaded|too many requests|service unavailable)/i.test(msg)
  ) {
    return true;
  }
  return false;
}

/**
 * Ordered failover over [primary, secondary]. On a retriable primary error it
 * retries the same request on the secondary. Composition (see llm.module.ts):
 * cache is OUTERMOST, this is inner — so a cache hit never touches either
 * provider, and a failover result is cached under the same key.
 *
 * - `id` is the primary's (the configured provider is what the turn "is").
 * - `contextWindow` is the min of the two — a prompt that fits must fit whoever
 *   actually serves it.
 * - `supportsTools` is either's (the pair can do tools if one can); the
 *   per-request guard below still refuses to hand a tool-carrying request to a
 *   secondary that can't do tools.
 */
export class FailoverChatProvider implements ChatProvider {
  readonly id: string;
  readonly contextWindow: number;
  readonly supportsTools: boolean;

  constructor(
    private readonly primary: ChatProvider,
    private readonly secondary: ChatProvider,
  ) {
    this.id = primary.id;
    this.contextWindow = Math.min(primary.contextWindow, secondary.contextWindow);
    this.supportsTools = primary.supportsTools || secondary.supportsTools;
  }

  private canFailOver(req: ChatRequest, err: unknown): boolean {
    if (!isRetriableProviderError(err)) return false;
    // Never route a tool-carrying request to a provider that can't do tools
    // (Groq is supportsTools:false) — it would silently drop the tools.
    if (req.tools?.length && !this.secondary.supportsTools) return false;
    return true;
  }

  async complete(req: ChatRequest, signal?: AbortSignal): Promise<ChatCompletion> {
    try {
      return await this.primary.complete(req, signal);
    } catch (err) {
      if (!this.canFailOver(req, err)) throw err;
      return this.secondary.complete(req, signal);
    }
  }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    let emittedText = false;
    try {
      for await (const event of this.primary.stream(req, signal)) {
        if (event.type === 'text') emittedText = true;
        yield event;
      }
      return;
    } catch (err) {
      // Never splice the secondary's output into a stream the client has
      // already begun rendering — only fail over if no text delta was emitted.
      if (emittedText || !this.canFailOver(req, err)) throw err;
    }
    yield* this.secondary.stream(req, signal);
  }
}
