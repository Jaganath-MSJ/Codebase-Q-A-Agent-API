import { Module } from '@nestjs/common';
import * as path from 'node:path';
import { ConfigService } from '../config/config.service';
import { GeminiChatProvider } from './providers/gemini.provider';
import { GroqChatProvider } from './providers/groq.provider';
import { CachingChatProvider } from './cache';
import { FailoverChatProvider } from './failover';
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
        // Failover: configured provider is primary, the other is secondary.
        // Composed cache-outermost, failover-inner (a cache hit skips both
        // providers; a failover result caches under the same key).
        const primary = config.chatProvider === 'groq' ? groq : gemini;
        const secondary = config.chatProvider === 'groq' ? gemini : groq;
        const inner = new FailoverChatProvider(primary, secondary);
        if (!config.llmCacheEnabled) return inner;
        return new CachingChatProvider(inner, path.join(config.dataDir, 'cache', 'llm'));
      },
    },
  ],
  exports: [CHAT_PROVIDER_TOKEN],
})
export class LlmModule {}
