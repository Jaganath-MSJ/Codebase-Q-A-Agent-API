import { Module } from '@nestjs/common';
import * as path from 'node:path';
import { ConfigService } from '../config/config.service';
import { LocalEmbeddingProvider } from './providers/local.provider';
import { CachingEmbeddingProvider } from './cache';
import type { EmbeddingProvider } from './embedding-provider.interface';

export const EMBEDDING_PROVIDER_TOKEN = Symbol('EMBEDDING_PROVIDER');

@Module({
  providers: [
    LocalEmbeddingProvider,
    {
      provide: EMBEDDING_PROVIDER_TOKEN,
      inject: [ConfigService, LocalEmbeddingProvider],
      useFactory: (
        config: ConfigService,
        local: LocalEmbeddingProvider,
      ): EmbeddingProvider => {
        if (config.embeddingProvider !== 'local') {
          throw new Error(
            `Embedding provider '${config.embeddingProvider}' is not implemented yet — ` +
              `Phase 1 only supports 'local'.`,
          );
        }
        return new CachingEmbeddingProvider(
          local,
          path.join(config.dataDir, 'cache', 'embeddings'),
        );
      },
    },
  ],
  exports: [EMBEDDING_PROVIDER_TOKEN],
})
export class EmbeddingsModule {}
