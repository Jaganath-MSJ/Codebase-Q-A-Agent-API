import { Injectable } from '@nestjs/common';
import { FinishReason, GoogleGenAI } from '@google/genai';
import { ConfigService } from '../../config/config.service';
import type { ChatCompletion, ChatEvent, ChatProvider, ChatRequest, ChatStopReason } from '../chat-provider.interface';

// Pinned dated model IDs (gemini-2.5-flash, gemini-2.0-flash, ...) either 404
// for new accounts or report a hard 0 free-tier quota depending on when the
// underlying Google Cloud project was created. The rolling "-latest" alias is
// what Google's own free tier actually grants new accounts access to.
const MODEL_ID = 'gemini-flash-latest';

function toStopReason(reason: FinishReason | undefined): ChatStopReason {
  if (reason === FinishReason.MAX_TOKENS) return 'length';
  return 'stop';
}

@Injectable()
export class GeminiChatProvider implements ChatProvider {
  readonly id = `gemini:${MODEL_ID}`;
  readonly contextWindow = 1_000_000;
  readonly supportsTools = false;

  private readonly client: GoogleGenAI;

  constructor(config: ConfigService) {
    this.client = new GoogleGenAI({ apiKey: config.googleApiKey });
  }

  async complete(req: ChatRequest, signal?: AbortSignal): Promise<ChatCompletion> {
    const response = await this.client.models.generateContent({
      model: MODEL_ID,
      contents: req.user,
      config: { systemInstruction: req.system, abortSignal: signal },
    });

    return {
      text: response.text ?? '',
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount,
        outputTokens: response.usageMetadata?.candidatesTokenCount,
      },
    };
  }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const stream = await this.client.models.generateContentStream({
      model: MODEL_ID,
      contents: req.user,
      config: { systemInstruction: req.system, abortSignal: signal },
    });

    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let stopReason: ChatStopReason = 'stop';

    for await (const chunk of stream) {
      if (chunk.text) yield { type: 'text', delta: chunk.text };
      if (chunk.usageMetadata) {
        inputTokens = chunk.usageMetadata.promptTokenCount;
        outputTokens = chunk.usageMetadata.candidatesTokenCount;
      }
      const finishReason = chunk.candidates?.[0]?.finishReason;
      if (finishReason) stopReason = toStopReason(finishReason);
    }

    yield { type: 'usage', inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
    yield { type: 'done', stopReason };
  }
}
