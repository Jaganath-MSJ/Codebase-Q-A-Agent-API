export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ChatCompletion {
  text: string;
  usage: ChatUsage;
}

export interface ChatRequest {
  system: string;
  user: string;
}

export type ChatStopReason = 'stop' | 'tool_use' | 'length' | 'error';

export type ChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; stopReason: ChatStopReason };

export interface ChatProvider {
  readonly id: string;
  readonly contextWindow: number;
  readonly supportsTools: boolean;
  stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent>;
  complete(req: ChatRequest, signal?: AbortSignal): Promise<ChatCompletion>;
}
