import { Injectable } from '@nestjs/common';
import Groq from 'groq-sdk';
import { ConfigService } from '../../config/config.service';
import type { ChatCompletion, ChatEvent, ChatProvider, ChatRequest, ChatStopReason } from '../chat-provider.interface';

// console.groq.com/docs/models — the strongest model on Groq's free tier for
// code reasoning (per docs/research-free-ai-providers.md). The model itself
// supports tool calling, but this provider doesn't wire up tool definitions
// yet (that's Phase 7) — hence supportsTools: false below, not a model limit.
const MODEL_ID = 'openai/gpt-oss-120b';

function toStopReason(reason: string | null | undefined): ChatStopReason {
  if (reason === 'length') return 'length';
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  return 'stop';
}

@Injectable()
export class GroqChatProvider implements ChatProvider {
  readonly id = `groq:${MODEL_ID}`;
  readonly contextWindow = 131_072;
  readonly supportsTools = false;

  private readonly client: Groq;

  constructor(config: ConfigService) {
    this.client = new Groq({ apiKey: config.groqApiKey });
  }

  async complete(req: ChatRequest, signal?: AbortSignal): Promise<ChatCompletion> {
    const response = await this.client.chat.completions.create(
      {
        model: MODEL_ID,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        max_completion_tokens: req.maxTokens,
      },
      { signal },
    );

    return {
      text: response.choices[0]?.message?.content ?? '',
      usage: {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      },
    };
  }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const stream = await this.client.chat.completions.create(
      {
        model: MODEL_ID,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        max_completion_tokens: req.maxTokens,
        stream: true,
      },
      { signal },
    );

    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let stopReason: ChatStopReason = 'stop';

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield { type: 'text', delta };

      const usage = chunk.x_groq?.usage;
      if (usage) {
        inputTokens = usage.prompt_tokens;
        outputTokens = usage.completion_tokens;
      }

      const finishReason = chunk.choices[0]?.finish_reason;
      if (finishReason) stopReason = toStopReason(finishReason);
    }

    yield { type: 'usage', inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
    yield { type: 'done', stopReason };
  }
}
