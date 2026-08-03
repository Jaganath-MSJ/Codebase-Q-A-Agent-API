export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ChatCompletion {
  text: string;
  usage: ChatUsage;
}

export interface ChatProvider {
  readonly id: string;
  readonly contextWindow: number;
  complete(req: { system: string; user: string }): Promise<ChatCompletion>;
}
