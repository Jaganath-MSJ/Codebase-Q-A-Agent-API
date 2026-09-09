import { describe, it, expect } from 'vitest';
import { ConfigService } from './config.service';
import type { Env } from './env.schema';

function config(env: Partial<Env>): ConfigService {
  return new ConfigService(env as Env);
}

describe('ConfigService.llmCacheEnabled', () => {
  // Phase 12.3: the cache is now enabled in production too — the NODE_ENV gate
  // is gone, and only LLM_CACHE=off disables it.
  it('is enabled in production (no longer gated on NODE_ENV)', () => {
    expect(config({ NODE_ENV: 'production', LLM_CACHE: 'on' }).llmCacheEnabled).toBe(true);
  });

  it('is enabled in development', () => {
    expect(config({ NODE_ENV: 'development', LLM_CACHE: 'on' }).llmCacheEnabled).toBe(true);
  });

  it('LLM_CACHE=off disables it, in production and development alike', () => {
    expect(config({ NODE_ENV: 'production', LLM_CACHE: 'off' }).llmCacheEnabled).toBe(false);
    expect(config({ NODE_ENV: 'development', LLM_CACHE: 'off' }).llmCacheEnabled).toBe(false);
  });
});
