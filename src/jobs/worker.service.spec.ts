import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { WorkerService } from './worker.service';
import { IndexCanceledError } from '../indexing/indexing.service';
import { EmbeddingQuotaExhaustedError } from '../indexing/rate-limiter';
import { EventBusService } from '../events/event-bus.service';
import type { JobsRepository } from '../db/repositories/jobs.repository';
import type { IndexingService } from '../indexing/indexing.service';
import type { ProgressReporter } from '../indexing/progress.reporter';
import type { IndexingJobRow } from '../db/schema';
import type { AppEvent } from '../events/event.types';

/**
 * QA pass — TC-WORK-*.
 *
 * The worker's own logic is queue discipline and failure classification; the
 * lease itself is enforced in SQL and is covered at L3. What matters here:
 *   - `drain()` is re-entrant-safe (every caller invokes it fire-and-forget)
 *   - a drain error is swallowed, never left to become an unhandled rejection
 *   - a quota pause stops the loop rather than hot-looping on a global limit
 *   - a failure message is redacted and NUL-stripped before it is persisted
 */

const jobRow = (id: string): IndexingJobRow =>
  ({
    id,
    projectId: `p-${id}`,
    trigger: 'initial',
  }) as unknown as IndexingJobRow;

interface Calls {
  claimed: string[];
  succeeded: string[];
  failed: { id: string; message: string }[];
  canceled: string[];
  paused: { id: string; message: string }[];
  failExceededAttempts: number;
}

function harness(
  options: {
    queue?: IndexingJobRow[];
    indexBehaviour?: (job: IndexingJobRow) => Promise<void>;
    claimError?: unknown;
    markFailedError?: unknown;
  } = {},
) {
  const { queue = [], indexBehaviour, claimError, markFailedError } = options;
  const pending = [...queue];
  const calls: Calls = {
    claimed: [],
    succeeded: [],
    failed: [],
    canceled: [],
    paused: [],
    failExceededAttempts: 0,
  };
  const events: AppEvent[] = [];

  const jobsRepository = {
    failExceededAttempts: () => {
      calls.failExceededAttempts++;
      return Promise.resolve();
    },
    claimNext: () => {
      // Injected failures are `unknown` by design — the worker must cope with
      // whatever the driver throws, including non-Error values.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      if (claimError) return Promise.reject(claimError);
      const next = pending.shift();
      if (next) calls.claimed.push(next.id);
      return Promise.resolve(next);
    },
    markSucceeded: (id: string) => {
      calls.succeeded.push(id);
      return Promise.resolve();
    },
    markFailed: (id: string, message: string) => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      if (markFailedError) return Promise.reject(markFailedError);
      calls.failed.push({ id, message });
      return Promise.resolve();
    },
    markCanceled: (id: string) => {
      calls.canceled.push(id);
      return Promise.resolve();
    },
    markPaused: (id: string, message: string) => {
      calls.paused.push({ id, message });
      return Promise.resolve();
    },
    heartbeat: () => Promise.resolve(),
    isCancelRequested: () => Promise.resolve(false),
  } as unknown as JobsRepository;

  const indexingService = {
    indexProject: (projectId: string) => {
      const job = queue.find((j) => j.projectId === projectId)!;
      return indexBehaviour ? indexBehaviour(job) : Promise.resolve();
    },
  } as unknown as IndexingService;

  const progressReporter = {
    forJob: () => ({}),
  } as unknown as ProgressReporter;

  const eventBus = new EventBusService();
  eventBus.onAny().subscribe((e) => events.push(e));

  const worker = new WorkerService(
    jobsRepository,
    indexingService,
    progressReporter,
    eventBus,
  );

  // `drain` is private; the constructor's job.created subscription is the
  // public way in, and exercising it also proves that wiring works.
  const triggerDrain = async () => {
    eventBus.emit({ type: 'job.created', projectId: 'p-x', jobId: 'j-x' });
    await vi.waitFor(() =>
      expect(calls.failExceededAttempts).toBeGreaterThan(0),
    );
    // let the drain loop settle
    await new Promise((r) => setTimeout(r, 20));
  };

  return { worker, calls, events, triggerDrain };
}

describe('WorkerService', () => {
  beforeEach(() => {
    // Nest's Logger writes straight to stdout, bypassing console spies. These
    // tests deliberately drive the failure paths, so silence it rather than
    // printing a dozen scary-looking errors during a passing run.
    Logger.overrideLogger(false);
  });

  afterEach(() => {
    Logger.overrideLogger(new ConsoleLogger());
    vi.restoreAllMocks();
  });

  describe('TC-WORK-001..004 — queue discipline', () => {
    it('TC-WORK-001 drains every queued job in order', async () => {
      const { calls, triggerDrain } = harness({
        queue: [jobRow('a'), jobRow('b'), jobRow('c')],
      });

      await triggerDrain();

      expect(calls.claimed).toEqual(['a', 'b', 'c']);
      expect(calls.succeeded).toEqual(['a', 'b', 'c']);
    });

    it('TC-WORK-002 reaps jobs that exceeded their attempt limit before claiming', async () => {
      const { calls, triggerDrain } = harness({ queue: [jobRow('a')] });
      await triggerDrain();
      expect(calls.failExceededAttempts).toBeGreaterThan(0);
    });

    it('TC-WORK-003 stops cleanly on an empty queue', async () => {
      const { calls, triggerDrain } = harness({ queue: [] });
      await triggerDrain();
      expect(calls.claimed).toEqual([]);
      expect(calls.succeeded).toEqual([]);
    });

    it('TC-WORK-004 emits job.completed for every job it ran', async () => {
      const { events, triggerDrain } = harness({
        queue: [jobRow('a'), jobRow('b')],
      });

      await triggerDrain();

      const completed = events.filter((e) => e.type === 'job.completed');
      expect(completed.map((e) => e.jobId)).toEqual(['a', 'b']);
    });
  });

  describe('TC-WORK-010..013 — failure classification', () => {
    it('TC-WORK-010 marks a cancelled job canceled, not failed', async () => {
      const { calls, triggerDrain } = harness({
        queue: [jobRow('a')],
        indexBehaviour: () =>
          Promise.reject(new IndexCanceledError('canceled by user')),
      });

      await triggerDrain();

      expect(calls.canceled).toEqual(['a']);
      expect(calls.failed).toEqual([]);
    });

    it('TC-WORK-011 pauses on quota exhaustion and stops draining (CONC)', async () => {
      // The daily embedding quota is global — continuing would hit the same
      // wall on every remaining job, so the loop must break rather than churn.
      const { calls, triggerDrain } = harness({
        queue: [jobRow('a'), jobRow('b'), jobRow('c')],
        indexBehaviour: () =>
          Promise.reject(new EmbeddingQuotaExhaustedError('daily cap reached')),
      });

      await triggerDrain();

      expect(calls.paused.map((p) => p.id)).toEqual(['a']);
      expect(calls.claimed).toEqual(['a']); // b and c were never claimed
    });

    it('TC-WORK-012 marks an ordinary error as failed and keeps draining', async () => {
      let first = true;
      const { calls, triggerDrain } = harness({
        queue: [jobRow('a'), jobRow('b')],
        indexBehaviour: () => {
          if (first) {
            first = false;
            return Promise.reject(new Error('chunker exploded'));
          }
          return Promise.resolve();
        },
      });

      await triggerDrain();

      expect(calls.failed.map((f) => f.id)).toEqual(['a']);
      expect(calls.succeeded).toEqual(['b']); // the queue kept moving
    });

    it('TC-WORK-013 survives markFailed itself failing', async () => {
      const { calls, triggerDrain } = harness({
        queue: [jobRow('a'), jobRow('b')],
        indexBehaviour: () => Promise.reject(new Error('boom')),
        markFailedError: new Error('database also down'),
      });

      await triggerDrain();

      // Both jobs were still attempted; the worker did not die recording a failure.
      expect(calls.claimed).toEqual(['a', 'b']);
    });
  });

  describe('TC-WORK-020..022 — failure message hygiene (SEC)', () => {
    it('TC-WORK-020 strips NUL bytes so the failure can be persisted', async () => {
      // Postgres text columns cannot store NUL; without stripping, recording
      // the failure would itself fail and the job would look stuck.
      const { calls, triggerDrain } = harness({
        queue: [jobRow('a')],
        indexBehaviour: () =>
          Promise.reject(new Error(`bad file\u0000name in repo`)),
      });

      await triggerDrain();

      expect(calls.failed[0]!.message).not.toContain('\u0000');
      expect(calls.failed[0]!.message).toContain('bad file');
    });

    it('TC-WORK-021 redacts a token that leaked into an error message', async () => {
      // A git subprocess can echo a bad credential in its own stderr.
      const { calls, triggerDrain } = harness({
        queue: [jobRow('a')],
        indexBehaviour: () =>
          Promise.reject(
            new Error(
              'fatal: could not read Password for https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com',
            ),
          ),
      });

      await triggerDrain();

      const message = calls.failed[0]!.message;
      expect(message).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    });

    it('TC-WORK-022 records a non-Error rejection as text', async () => {
      const { calls, triggerDrain } = harness({
        queue: [jobRow('a')],
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        indexBehaviour: () => Promise.reject('a bare string failure'),
      });

      await triggerDrain();

      expect(calls.failed[0]!.message).toContain('a bare string failure');
    });
  });

  describe('TC-WORK-030..031 — re-entrancy and resilience', () => {
    it('TC-WORK-030 does not double-process when drain is triggered concurrently', async () => {
      const { calls, events, triggerDrain } = harness({
        queue: [jobRow('a'), jobRow('b')],
        indexBehaviour: () => new Promise((r) => setTimeout(r, 30)),
      });

      // Three overlapping wake-ups; the `draining` guard must collapse them.
      const bus = events; // captured for clarity
      void triggerDrain();
      void triggerDrain();
      await triggerDrain();
      await new Promise((r) => setTimeout(r, 150));

      expect(calls.claimed).toEqual(['a', 'b']);
      expect(calls.succeeded).toEqual(['a', 'b']);
      expect(bus.filter((e) => e.type === 'job.completed')).toHaveLength(2);
    });

    it('TC-WORK-031 swallows a claim error instead of crashing the worker', async () => {
      // Callers use `void this.drain()`, so an escaping rejection would become
      // an unhandled rejection. The 60s safety poll retries instead.
      const { triggerDrain } = harness({
        queue: [jobRow('a')],
        claimError: Object.assign(new Error('ECONNRESET'), {
          code: 'ECONNRESET',
        }),
      });

      await expect(triggerDrain()).resolves.toBeUndefined();
    });
  });
});
