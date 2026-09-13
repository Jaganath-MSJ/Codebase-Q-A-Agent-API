export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ChatCompletion {
  text: string;
  usage: ChatUsage;
  /**
   * The `id` of the concrete provider that actually served this request. Set by
   * the leaf providers and passed through unchanged by the failover/cache
   * wrappers, so a request that failed over to the secondary is recorded under
   * the provider that really produced it — not the wrapper's static `id` (which
   * is always the primary's). Optional so older cache entries lacking it still
   * parse.
   */
  servedBy?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /**
   * Opaque provider-specific data that must round-trip verbatim on the next
   * turn — e.g. Gemini's `thoughtSignature`, required back on the function-
   * call part or the follow-up request is rejected. Never inspected outside
   * the provider that set it.
   */
  providerData?: unknown;
}

export interface ToolResultTurn {
  toolCallId: string;
  name: string;
  content: string;
}

/**
 * A turn appended after the initial system+user message, for multi-step tool
 * loops. Absent entirely for every existing single-turn caller (condense,
 * summarize, plain RAG generation) — only the Phase 7 agent loop populates it.
 */
export type PriorTurn =
  | { role: 'assistant'; content: string; toolCalls: ToolCall[] }
  | { role: 'tool'; results: ToolResultTurn[] };

export interface ChatRequest {
  system: string;
  user: string;
  tools?: ToolDefinition[];
  priorTurns?: PriorTurn[];
  /**
   * Optional cap on generated (output) tokens — bounds latency and quota.
   * Callers set an intent-appropriate value (generous for generation, small for
   * condense/summary, medium for the tour). When the model hits it, the stop
   * reason is 'length'. Omitted = provider default.
   */
  maxTokens?: number;
}

export type ChatStopReason = 'stop' | 'tool_use' | 'length' | 'error';

export type ChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown>; providerData?: unknown }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  // `servedBy`: the concrete provider that produced this stream — see
  // ChatCompletion.servedBy. Optional so a cached stream from before this
  // field existed still replays.
  | { type: 'done'; stopReason: ChatStopReason; servedBy?: string };

export interface ChatProvider {
  readonly id: string;
  readonly contextWindow: number;
  readonly supportsTools: boolean;
  stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent>;
  complete(req: ChatRequest, signal?: AbortSignal): Promise<ChatCompletion>;
}
