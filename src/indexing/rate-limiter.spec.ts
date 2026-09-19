import { describe, it, expect, vi } from 'vitest';
import {
  EmbeddingRateLimiter,
  EmbeddingQuotaExhaustedError,
} from './rate-limiter';
import type { JobsRepository } from '../db/repositories/jobs.repository';
import type { EmbeddingProvider } from '../embeddings/embedding-provider.interface';

function provider(id: string): EmbeddingProvider {
  return {
    id,
    dimensions: 768,
    maxBatchSize: 64,
    embedDocuments: vi.fn(),
    embedQuery: vi.fn(),
  };
}

function jobsRepo(usedToday: number) {
  const sumEmbedRequestsToday = vi.fn().mockResolvedValue(usedToday);
  return {
    repo: { sumEmbedRequestsToday } as unknown as JobsRepository,
    sumEmbedRequestsToday,
  };
}

describe('EmbeddingRateLimiter.reserve — provider gating', () => {
  it('skips the daily-sum DB aggregate entirely for the local provider', async () => {
    const { repo, sumEmbedRequestsToday } = jobsRepo(0);
    const limiter = new EmbeddingRateLimiter(
      repo,
      provider('local:nomic-ai/nomic-embed-text-v1.5'),
    );
    await limiter.reserve();
    expect(sumEmbedRequestsToday).not.toHaveBeenCalled();
  });

  it('does not throw for local even if the (unread) daily total would be over budget', async () => {
    const { repo } = jobsRepo(10_000);
    const limiter = new EmbeddingRateLimiter(
      repo,
      provider('local:nomic-ai/nomic-embed-text-v1.5'),
    );
    await expect(limiter.reserve()).resolves.toBeUndefined();
  });

  it('still reads the daily-sum for a hosted (non-local) provider', async () => {
    const { repo, sumEmbedRequestsToday } = jobsRepo(0);
    const limiter = new EmbeddingRateLimiter(
      repo,
      provider('gemini:text-embedding-004'),
    );
    await limiter.reserve();
    expect(sumEmbedRequestsToday).toHaveBeenCalledOnce();
  });

  it('preserves the 900/day guard exactly for a hosted provider', async () => {
    const { repo } = jobsRepo(900);
    const limiter = new EmbeddingRateLimiter(
      repo,
      provider('gemini:text-embedding-004'),
    );
    await expect(limiter.reserve()).rejects.toBeInstanceOf(
      EmbeddingQuotaExhaustedError,
    );
  });
});
