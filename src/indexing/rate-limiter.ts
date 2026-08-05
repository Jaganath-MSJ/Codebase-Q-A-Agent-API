import { Injectable } from '@nestjs/common';
import { JobsRepository } from '../db/repositories/jobs.repository';

export interface RateLimitConfig {
  requestsPerMinute: number;
  requestsPerDay: number;
}

// Deliberately under the real free-tier limits so a slightly-off local clock
// or another process's usage never tips a hosted provider into a real 429/ban.
export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  requestsPerMinute: 60,
  requestsPerDay: 900,
};

export class EmbeddingQuotaExhaustedError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Per-minute pacing lives in memory (resetting on restart is fine — a fresh
 * process can burst again for up to a minute). The per-day budget is derived
 * from `SUM(embed_requests)` across today's job rows, so it survives restarts
 * and is shared across every job, not just this one.
 */
@Injectable()
export class EmbeddingRateLimiter {
  private minuteWindowStart = Date.now();
  private requestsThisMinute = 0;

  constructor(private readonly jobsRepository: JobsRepository) {}

  /** Resolves once there's room in the per-minute bucket, or throws if today's budget is used up. */
  async reserve(config: RateLimitConfig = DEFAULT_RATE_LIMIT): Promise<void> {
    const usedToday = await this.jobsRepository.sumEmbedRequestsToday();
    if (usedToday >= config.requestsPerDay) {
      throw new EmbeddingQuotaExhaustedError(
        `Daily embedding request budget (${config.requestsPerDay}) reached; will resume once it resets.`,
      );
    }

    const now = Date.now();
    if (now - this.minuteWindowStart >= 60_000) {
      this.minuteWindowStart = now;
      this.requestsThisMinute = 0;
    }
    if (this.requestsThisMinute >= config.requestsPerMinute) {
      await sleep(60_000 - (now - this.minuteWindowStart));
      this.minuteWindowStart = Date.now();
      this.requestsThisMinute = 0;
    }
    this.requestsThisMinute++;
  }
}

function extractRetryAfterMs(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const retryAfterMs = (err as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof retryAfterMs === 'number' ? retryAfterMs : null;
}

/** Exponential backoff with full jitter starting at 2s; respects a duck-typed `retryAfterMs` on the error. */
export async function withEmbeddingRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      const backoffMs = extractRetryAfterMs(err) ?? 2000 * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5);
      await sleep(backoffMs);
    }
  }
}
