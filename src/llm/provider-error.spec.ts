import { describe, it, expect } from 'vitest';
import {
  classifyProviderError,
  userFacingProviderMessage,
  estimateRequestTokens,
  fitsWithinBudget,
} from './provider-error';
import type { ChatRequest } from './chat-provider.interface';

/**
 * The fixtures below are the **real** error shapes observed from Gemini and
 * Groq during QA round 2, not invented ones — that is the whole value of them.
 */

const GEMINI_503 = new Error(
  'got status: UNAVAILABLE. {"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}',
);

const GROQ_413 = Object.assign(
  new Error(
    '413 {"error":{"message":"Request too large for model `openai/gpt-oss-120b` in organization `org_01kyyfddpqehdb6ngrv7b53xsg` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 11285, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing","type":"tokens","code":"rate_limit_exceeded"}}',
  ),
  { status: 413 },
);

const GEMINI_QUOTA = new Error('got status: RESOURCE_EXHAUSTED for quota');

describe('classifyProviderError', () => {
  it('classifies the real Gemini 503 as unavailable', () => {
    expect(classifyProviderError(GEMINI_503)).toBe('unavailable');
  });

  it('classifies the real Groq 413 as too_large', () => {
    expect(classifyProviderError(GROQ_413)).toBe('too_large');
  });

  it('classifies a quota exhaustion as rate_limited', () => {
    expect(classifyProviderError(GEMINI_QUOTA)).toBe('rate_limited');
    expect(classifyProviderError({ status: 429 })).toBe('rate_limited');
  });

  it('classifies auth failures', () => {
    expect(classifyProviderError({ status: 401 })).toBe('auth');
    expect(classifyProviderError({ status: 403 })).toBe('auth');
  });

  it('returns null for anything that is not a provider error', () => {
    // The important negative: a database fault or a bug in our own code must
    // not be dressed up as "the model is busy", which would hide real defects.
    expect(
      classifyProviderError(new Error('column "foo" does not exist')),
    ).toBeNull();
    expect(
      classifyProviderError(new Error('Cannot read properties of undefined')),
    ).toBeNull();
    expect(classifyProviderError({ status: 500 })).toBeNull();
    expect(classifyProviderError(null)).toBeNull();
    expect(classifyProviderError('429')).toBeNull();
  });

  it('does not match a bare number with no qualifying word', () => {
    expect(classifyProviderError(new Error('order 429 shipped'))).toBeNull();
  });
});

describe('userFacingProviderMessage — DEF-028', () => {
  it('replaces the Groq 413 with something a user can act on', () => {
    const message = userFacingProviderMessage(GROQ_413)!;
    expect(message).toMatch(/more context than the model would accept/i);

    // The specific things that must never survive into the UI. Each was
    // actually rendered to the user before this fix.
    expect(message).not.toMatch(/console\.groq\.com/);
    expect(message).not.toMatch(/org_[a-z0-9]+/);
    expect(message).not.toMatch(/Upgrade to Dev Tier/i);
    expect(message).not.toMatch(/gpt-oss/);
    expect(message).not.toMatch(/[{}]/);
  });

  it('replaces the Gemini 503 with a plain retry message', () => {
    const message = userFacingProviderMessage(GEMINI_503)!;
    expect(message).toMatch(/temporarily unavailable/i);
    expect(message).not.toMatch(/[{}]/);
    expect(message).not.toMatch(/UNAVAILABLE/);
  });

  it('returns null for a non-provider error so the caller keeps its own handling', () => {
    expect(userFacingProviderMessage(new Error('boom'))).toBeNull();
  });
});

describe('estimateRequestTokens / fitsWithinBudget — DEF-029', () => {
  const req = (chars: number): ChatRequest => ({
    system: 'x'.repeat(Math.floor(chars / 2)),
    user: 'y'.repeat(Math.ceil(chars / 2)),
  });

  it('approximates four characters per token', () => {
    expect(estimateRequestTokens(req(4000))).toBe(1000);
  });

  it('counts tool definitions too', () => {
    const withTools: ChatRequest = {
      ...req(400),
      tools: [
        { name: 'search_code', description: 'd'.repeat(400), parameters: {} },
      ],
    };
    expect(estimateRequestTokens(withTools)).toBeGreaterThan(
      estimateRequestTokens(req(400)),
    );
  });

  it('treats a provider with no declared budget as unconstrained', () => {
    expect(fitsWithinBudget(req(10_000_000), undefined)).toBe(true);
  });

  it("rejects the real case: an 11k-token prompt against Groq's 8k TPM", () => {
    // 45,140 chars ≈ 11,285 tokens — the exact request Groq refused on
    // 2026-09-17, against its free-tier ceiling of 8,000.
    expect(fitsWithinBudget(req(45_140), 8_000)).toBe(false);
  });

  it('accepts a request that fits, including the headroom', () => {
    expect(fitsWithinBudget(req(32_000), 8_000)).toBe(true); // exactly 8,000
    expect(fitsWithinBudget(req(34_000), 8_000)).toBe(true); // 8,500, inside +10%
    expect(fitsWithinBudget(req(36_000), 8_000)).toBe(false); // 9,000, beyond it
  });
});
