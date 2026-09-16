import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installProcessBackstops } from './process-backstops';

/**
 * QA pass — TC-BACK-*.
 *
 * DEF-007: `main.ts` installed a backstop for `unhandledRejection` but not for
 * its synchronous twin `uncaughtException`, so one throwing event-bus
 * subscriber would have exited the whole API.
 *
 * Every test here detaches the real listeners first and restores them in
 * `afterEach`. Without that, the harness's own handlers (and vitest's) would
 * see these deliberate errors and fail the run for the wrong reason.
 */

const CHANNELS = ['unhandledRejection', 'uncaughtException'] as const;

describe('installProcessBackstops', () => {
  const saved = new Map<string, ReturnType<typeof process.listeners>>();

  beforeEach(() => {
    for (const channel of CHANNELS) {
      saved.set(channel, process.listeners(channel));
      process.removeAllListeners(channel);
    }
  });

  afterEach(() => {
    for (const channel of CHANNELS) {
      process.removeAllListeners(channel);
      for (const listener of saved.get(channel) ?? []) {
        process.on(channel, listener as never);
      }
    }
    saved.clear();
  });

  it('TC-BACK-001 [DEFECT-007 fixed] installs BOTH backstops, not just the async one', () => {
    installProcessBackstops({ error: vi.fn() });

    // The asymmetry was the defect. Asserting on both counts means a future
    // edit that drops one is a failing test rather than a silent regression.
    expect(process.listenerCount('unhandledRejection')).toBe(1);
    expect(process.listenerCount('uncaughtException')).toBe(1);
  });

  it('TC-BACK-002 [DEFECT-007 fixed] logs an uncaught exception instead of letting it exit', () => {
    const error = vi.fn();
    installProcessBackstops({ error });

    // Invoking the registered listener directly is the honest test: actually
    // throwing on a macro task would either kill the worker or be swallowed by
    // whichever handler happened to be attached, proving nothing either way.
    const [listener] = process.listeners('uncaughtException');
    listener!(new Error('subscriber exploded'), 'uncaughtException');

    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]![0]).toContain('Uncaught exception');
    expect(error.mock.calls[0]![0]).toContain('subscriber exploded');
  });

  it('TC-BACK-003 logs the stack, not just the message', () => {
    // A bare message from a background thrower is close to useless — the whole
    // point of surviving the error is being able to find it afterwards.
    const error = vi.fn();
    installProcessBackstops({ error });

    const [listener] = process.listeners('uncaughtException');
    listener!(new Error('boom'), 'uncaughtException');

    expect(error.mock.calls[0]![0]).toContain('process-backstops.spec.ts');
  });

  it('TC-BACK-004 survives a non-Error thrown value', () => {
    // `throw 'a string'` is legal JavaScript, and a backstop that itself throws
    // on `.stack` would turn a survivable error into the exit it exists to
    // prevent.
    const error = vi.fn();
    installProcessBackstops({ error });

    const [listener] = process.listeners('uncaughtException');
    expect(() =>
      listener!('just a string' as never, 'uncaughtException'),
    ).not.toThrow();
    expect(error.mock.calls[0]![0]).toContain('just a string');
  });

  it('TC-BACK-005 still logs an unhandled rejection', () => {
    // The pre-existing half, pinned here for the first time so the extraction
    // out of main.ts cannot have quietly changed it.
    const error = vi.fn();
    installProcessBackstops({ error });

    const [listener] = process.listeners('unhandledRejection');
    listener!(new Error('poller died'), Promise.resolve());

    expect(error.mock.calls[0]![0]).toContain('Unhandled promise rejection');
    expect(error.mock.calls[0]![0]).toContain('poller died');
  });
});
