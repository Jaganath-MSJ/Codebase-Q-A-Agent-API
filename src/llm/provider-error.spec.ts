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

/**
 * DEF-034 — the estimate counted only `system`, `user` and the tool
 * definitions, so `fitsWithinBudget` under-counted and could answer "fits" for
 * a request that does not.
 *
 * Two omissions, with very different reach, both fixed here:
 *
 *  - `maxTokens`, the output allowance. **Live today.** A tokens-per-minute
 *    ceiling is charged for input *and* output, but only input was measured.
 *  - `priorTurns`, the accumulated agent-loop history. **Latent**: the only
 *    caller that populates it always sends tools, which `canFailOver` already
 *    refuses for the `supportsTools: false` secondary. It becomes reachable
 *    the moment a tools-capable secondary is configured, and it is the largest
 *    and fastest-growing part of a multi-step request when it does.
 */
describe('estimateRequestTokens — DEF-034', () => {
  const base: ChatRequest = {
    system: 'x'.repeat(2_000),
    user: 'y'.repeat(2_000),
  };

  it('counts the output allowance, because a TPM ceiling charges for it', () => {
    expect(estimateRequestTokens({ ...base, maxTokens: 2_048 })).toBe(
      estimateRequestTokens(base) + 2_048,
    );
  });

  it('counts priorTurns — assistant text, tool results and call arguments', () => {
    const withHistory: ChatRequest = {
      ...base,
      priorTurns: [
        {
          role: 'assistant',
          content: 'a'.repeat(4_000),
          toolCalls: [
            { id: 't1', name: 'search_code', args: { query: 'q'.repeat(400) } },
          ],
        },
        {
          role: 'tool',
          results: [
            {
              toolCallId: 't1',
              name: 'search_code',
              content: 'r'.repeat(8_000),
            },
          ],
        },
      ],
    };
    // 12,000+ characters of history is at least 3,000 tokens; the old estimate
    // scored this identically to `base`.
    expect(estimateRequestTokens(withHistory)).toBeGreaterThanOrEqual(
      estimateRequestTokens(base) + 3_000,
    );
  });

  it('is unchanged for a plain single-turn request', () => {
    // The RAG path sets neither field, so the DEF-029 numbers above must not
    // move — this is what keeps that fix's calibration honest.
    expect(estimateRequestTokens(base)).toBe(1_000);
  });

  it('closes the live gap: output pushes a borderline request over the ceiling', () => {
    // The band where this actually bites is narrow, so the numbers matter.
    // Against an 8,000 budget the gate allows 8,800 after headroom, and
    // generation asks for 2,048 output — so a request flips verdict only when
    // its input is above 8,800 − 2,048 = 6,752 tokens and still under 8,800.
    //
    // 28,000 chars ≈ 7,000 input tokens sits squarely in that band: it passed
    // on input alone, and 7,000 + 2,048 = 9,048 is over the ceiling it was
    // about to be charged against.
    const borderline: ChatRequest = {
      system: 'x'.repeat(14_000),
      user: 'y'.repeat(14_000),
      maxTokens: 2_048,
    };
    expect(estimateRequestTokens({ ...borderline, maxTokens: undefined })).toBe(
      7_000,
    );
    expect(fitsWithinBudget(borderline, 8_000)).toBe(false);
  });
});
