import { describe, it, expect, vi } from 'vitest';
import { ChatService } from '../../src/chat/chat.service';

/**
 * QA round 2 — TC-R2-3xx. DEF-028: what a user is allowed to read when a turn
 * fails.
 *
 * **Why the helper is reached directly.** The mapping lives in a private method
 * on `ChatService`, and the L2 chat spec stubs `ChatService` wholesale — so the
 * contract layer cannot see it, the same structural blind spot recorded for
 * DEF-015 and DEF-018. Constructing the real service would mean standing up ten
 * collaborators to exercise two branches of one pure-ish function, which tests
 * the harness rather than the behaviour. `Object.create` gives the prototype
 * without the graph.
 *
 * The classifier it delegates to has its own full coverage in
 * `src/llm/provider-error.spec.ts`; what these assert is the *wiring* — that
 * ChatService actually routes failures through it, and what it does with the
 * ones it does not recognise.
 */

/** Just the two members the helper touches, so the type resolves cleanly. */
interface ErrorSurface {
  logger: { warn: ReturnType<typeof vi.fn> };
  clientFacingError(err: unknown): string;
}

function errorSurface(): ErrorSurface {
  const service = Object.create(ChatService.prototype) as ErrorSurface;
  service.logger = { warn: vi.fn() };
  return service;
}

const GROQ_413 = Object.assign(
  new Error(
    '413 {"error":{"message":"Request too large for model `openai/gpt-oss-120b` in organization `org_01kyyfddpqehdb6ngrv7b53xsg` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 11285, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing","type":"tokens","code":"rate_limit_exceeded"}}',
  ),
  { status: 413 },
);

describe('TC-R2-3xx — DEF-028 provider errors reaching the user', () => {
  it('TC-R2-300 [DEF-028 FIXED] the Groq 413 no longer reaches the transcript raw', () => {
    const service = errorSurface();
    const shown = service.clientFacingError(GROQ_413);

    // Every one of these was rendered verbatim in the chat UI before the fix.
    expect(shown).not.toContain('console.groq.com');
    expect(shown).not.toContain('org_01kyyfddpqehdb6ngrv7b53xsg');
    expect(shown).not.toContain('Upgrade to Dev Tier');
    expect(shown).not.toContain('gpt-oss-120b');
    expect(shown).not.toContain('{');
    expect(shown).toMatch(/more context than the model would accept/i);
  });

  it('TC-R2-301 [DEF-028] the raw provider text still reaches the server log', () => {
    // The information is not thrown away — it moves to where it is useful.
    const service = errorSurface();
    service.clientFacingError(GROQ_413);
    expect(service.logger.warn).toHaveBeenCalledOnce();
    expect(String(service.logger.warn.mock.calls[0]![0])).toContain(
      'Request too large',
    );
  });

  it('TC-R2-302 [DEF-028] a NON-provider error is not disguised as one', () => {
    // The mistake this fix is careful not to make. Flattening everything into
    // "the model is busy" would hide real defects behind a reassuring sentence,
    // so an unrecognised failure keeps its (redacted) message.
    const service = errorSurface();
    const shown = service.clientFacingError(
      new Error('column "foo" does not exist'),
    );
    expect(shown).toBe('column "foo" does not exist');
    expect(service.logger.warn).not.toHaveBeenCalled();
  });

  it('TC-R2-303 [DEF-028] credential redaction still applies to the fallback', () => {
    // redactSecrets predates this change and must survive it: a provider or git
    // error can echo a token in its own message text.
    const service = errorSurface();
    const shown = service.clientFacingError(
      new Error(
        'fatal: could not read Password for https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com',
      ),
    );
    expect(shown).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('TC-R2-304 [DEF-028] a non-Error throw still yields a string', () => {
    const service = errorSurface();
    expect(typeof service.clientFacingError('just a string')).toBe('string');
    expect(typeof service.clientFacingError(undefined)).toBe('string');
  });
});
