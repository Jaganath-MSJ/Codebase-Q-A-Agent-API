import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProgressReporter } from './progress.reporter';
import type { JobsRepository } from '../db/repositories/jobs.repository';
import type { EventBusService } from '../events/event-bus.service';

function build() {
  const updateProgress = vi.fn().mockResolvedValue(undefined);
  const emit = vi.fn();
  const reporter = new ProgressReporter(
    { updateProgress } as unknown as JobsRepository,
    { emit } as unknown as EventBusService,
  );
  const onProgress = reporter.forJob({ id: 'j1', projectId: 'p1' });
  return { onProgress, updateProgress, emit };
}

describe('ProgressReporter coalescing (Phase 12.10)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it('emits an SSE signal on every update but coalesces DB writes', async () => {
    const { onProgress, updateProgress, emit } = build();
    // 50 same-phase updates with no time advance.
    for (let i = 0; i < 50; i++) await onProgress({ phase: 'chunking', filesDone: i, filesTotal: 50 });
    expect(emit).toHaveBeenCalledTimes(50); // immediate SSE every update
    expect(updateProgress).toHaveBeenCalledTimes(1); // only the first (phase transition)
  });

  it('writes again once ~500ms has elapsed', async () => {
    const { onProgress, updateProgress } = build();
    await onProgress({ phase: 'chunking', filesDone: 0 }); // persist (transition)
    await onProgress({ phase: 'chunking', filesDone: 1 }); // coalesced
    expect(updateProgress).toHaveBeenCalledTimes(1);
    vi.setSystemTime(600);
    await onProgress({ phase: 'chunking', filesDone: 2 }); // due → persist
    expect(updateProgress).toHaveBeenCalledTimes(2);
  });

  it('always persists a phase transition and flushes the prior phase final counts', async () => {
    const { onProgress, updateProgress } = build();
    await onProgress({ phase: 'chunking', filesDone: 0, filesTotal: 168 }); // persist (transition)
    await onProgress({ phase: 'chunking', filesDone: 168, filesTotal: 168 }); // coalesced (pending)
    expect(updateProgress).toHaveBeenCalledTimes(1);

    await onProgress({ phase: 'embedding', chunksTotal: 10 }); // transition → flush + persist
    expect(updateProgress).toHaveBeenCalledTimes(3);
    // The flush writes the prior phase's final (168), then the transition itself.
    expect(updateProgress).toHaveBeenNthCalledWith(2, 'j1', { phase: 'chunking', filesDone: 168, filesTotal: 168 });
    expect(updateProgress).toHaveBeenNthCalledWith(3, 'j1', { phase: 'embedding', chunksTotal: 10 });
  });
});
