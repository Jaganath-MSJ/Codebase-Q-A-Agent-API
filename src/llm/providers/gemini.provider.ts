import { Injectable } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { ConfigService } from '../../config/config.service';
import type { ChatCompletion, ChatProvider } from '../chat-provider.interface';

// Pinned dated model IDs (gemini-2.5-flash, gemini-2.0-flash, ...) either 404
// for new accounts or report a hard 0 free-tier quota depending on when the
// underlying Google Cloud project was created. The rolling "-latest" alias is
// what Google's own free tier actually grants new accounts access to.
const MODEL_ID = 'gemini-flash-latest';

@Injectable()
export class GeminiChatProvider implements ChatProvider {
  readonly id = `gemini:${MODEL_ID}`;
  readonly contextWindow = 1_000_000;

  private readonly client: GoogleGenAI;

  constructor(config: ConfigService) {
    this.client = new GoogleGenAI({ apiKey: config.googleApiKey });
  }

  async complete(req: { system: string; user: string }): Promise<ChatCompletion> {
    const response = await this.client.models.generateContent({
      model: MODEL_ID,
      contents: req.user,
      config: { systemInstruction: req.system },
    });

    return {
      text: response.text ?? '',
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount,
        outputTokens: response.usageMetadata?.candidatesTokenCount,
      },
    };
  }
}
