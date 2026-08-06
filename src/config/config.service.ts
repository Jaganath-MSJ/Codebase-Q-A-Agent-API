import { Inject, Injectable } from '@nestjs/common';
import type { Env } from './env.schema';

export const ENV_TOKEN = Symbol('ENV');

@Injectable()
export class ConfigService {
  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  get databaseUrl(): string {
    return this.env.DATABASE_URL;
  }

  get googleApiKey(): string {
    return this.env.GOOGLE_API_KEY;
  }

  get groqApiKey(): string {
    return this.env.GROQ_API_KEY;
  }

  get embeddingProvider(): Env['EMBEDDING_PROVIDER'] {
    return this.env.EMBEDDING_PROVIDER;
  }

  get chatProvider(): Env['CHAT_PROVIDER'] {
    return this.env.CHAT_PROVIDER;
  }

  get dataDir(): string {
    return this.env.DATA_DIR;
  }

  get port(): number {
    return this.env.PORT;
  }

  get llmCacheEnabled(): boolean {
    return this.env.NODE_ENV !== 'production' && this.env.LLM_CACHE !== 'off';
  }
}
