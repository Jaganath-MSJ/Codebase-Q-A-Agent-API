import { Module } from '@nestjs/common';
import * as path from 'node:path';
import { ConfigService } from '../config/config.service';
import { GeminiChatProvider } from './providers/gemini.provider';
import { CachingChatProvider } from './cache';
import type { ChatProvider } from './chat-provider.interface';

export const CHAT_PROVIDER_TOKEN = Symbol('CHAT_PROVIDER');

@Module({
  providers: [
    GeminiChatProvider,
    {
      provide: CHAT_PROVIDER_TOKEN,
      inject: [ConfigService, GeminiChatProvider],
      useFactory: (config: ConfigService, gemini: GeminiChatProvider): ChatProvider => {
        if (config.chatProvider !== 'gemini') {
          throw new Error(
            `Chat provider '${config.chatProvider}' is not implemented yet — Phase 1 only supports 'gemini'.`,
          );
        }
        if (!config.llmCacheEnabled) return gemini;
        return new CachingChatProvider(gemini, path.join(config.dataDir, 'cache', 'llm'));
      },
    },
  ],
  exports: [CHAT_PROVIDER_TOKEN],
})
export class LlmModule {}
