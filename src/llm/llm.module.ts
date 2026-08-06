import { Module } from '@nestjs/common';
import * as path from 'node:path';
import { ConfigService } from '../config/config.service';
import { GeminiChatProvider } from './providers/gemini.provider';
import { GroqChatProvider } from './providers/groq.provider';
import { CachingChatProvider } from './cache';
import type { ChatProvider } from './chat-provider.interface';

export const CHAT_PROVIDER_TOKEN = Symbol('CHAT_PROVIDER');

@Module({
  providers: [
    GeminiChatProvider,
    GroqChatProvider,
    {
      provide: CHAT_PROVIDER_TOKEN,
      inject: [ConfigService, GeminiChatProvider, GroqChatProvider],
      useFactory: (
        config: ConfigService,
        gemini: GeminiChatProvider,
        groq: GroqChatProvider,
      ): ChatProvider => {
        const inner = config.chatProvider === 'groq' ? groq : gemini;
        if (!config.llmCacheEnabled) return inner;
        return new CachingChatProvider(inner, path.join(config.dataDir, 'cache', 'llm'));
      },
    },
  ],
  exports: [CHAT_PROVIDER_TOKEN],
})
export class LlmModule {}
