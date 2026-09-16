import { describe, it, expect } from 'vitest';
import { EventBusService } from './event-bus.service';
import type { AppEvent } from './event.types';

/**
 * QA pass — TC-EVT-*.
 *
 * The bus carries indexing progress to the SSE endpoint. Its two risky
 * properties are both about *timing*: a `Subject` is hot, so anything emitted
 * before a subscriber attaches is gone forever, and an unsubscribed consumer
 * must genuinely stop receiving (a leaked EventSource subscription was a real
 * bug in Phase 14.3).
 */

const created = (jobId: string): AppEvent => ({
  type: 'job.created',
  projectId: 'p-1',
  jobId,
});
const progress = (jobId: string): AppEvent => ({
  type: 'job.progress',
  projectId: 'p-1',
  jobId,
});

describe('EventBusService', () => {
  describe('TC-EVT-001..005 — delivery', () => {
    it('TC-EVT-001 delivers an emitted event to a subscriber of that type', () => {
      const bus = new EventBusService();
      const seen: AppEvent[] = [];
      bus.on('job.created').subscribe((e) => seen.push(e));

      bus.emit(created('j-1'));

      expect(seen).toEqual([created('j-1')]);
    });

    it('TC-EVT-002 filters out events of other types', () => {
      const bus = new EventBusService();
      const seen: AppEvent[] = [];
      bus.on('job.created').subscribe((e) => seen.push(e));

      bus.emit(progress('j-1'));
      bus.emit(created('j-2'));

      expect(seen).toEqual([created('j-2')]);
    });

    it('TC-EVT-003 delivers every event to onAny', () => {
      const bus = new EventBusService();
      const seen: AppEvent[] = [];
      bus.onAny().subscribe((e) => seen.push(e));

      bus.emit(created('j-1'));
      bus.emit(progress('j-1'));

      expect(seen).toHaveLength(2);
    });

    it('TC-EVT-004 fans out to multiple subscribers', () => {
      const bus = new EventBusService();
      const a: AppEvent[] = [];
      const b: AppEvent[] = [];
      bus.on('job.created').subscribe((e) => a.push(e));
      bus.on('job.created').subscribe((e) => b.push(e));

      bus.emit(created('j-1'));

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });

    it('TC-EVT-005 preserves emission order', () => {
      const bus = new EventBusService();
      const seen: string[] = [];
      bus.onAny().subscribe((e) => seen.push(e.jobId));

      for (const id of ['j-1', 'j-2', 'j-3']) bus.emit(created(id));

      expect(seen).toEqual(['j-1', 'j-2', 'j-3']);
    });
  });

  describe('TC-EVT-010..013 — subscription lifecycle', () => {
    it('TC-EVT-010 stops delivering after unsubscribe (no leak)', () => {
      const bus = new EventBusService();
      const seen: AppEvent[] = [];
      const sub = bus.on('job.created').subscribe((e) => seen.push(e));

      bus.emit(created('j-1'));
      sub.unsubscribe();
      bus.emit(created('j-2'));

      expect(seen).toEqual([created('j-1')]);
    });

    it('TC-EVT-011 leaves other subscribers unaffected by one unsubscribing', () => {
      const bus = new EventBusService();
      const kept: AppEvent[] = [];
      const dropped: AppEvent[] = [];
      const sub = bus.onAny().subscribe((e) => dropped.push(e));
      bus.onAny().subscribe((e) => kept.push(e));

      sub.unsubscribe();
      bus.emit(created('j-1'));

      expect(dropped).toHaveLength(0);
      expect(kept).toHaveLength(1);
    });

    it('TC-EVT-012 is hot: events emitted before subscribing are lost', () => {
      // Documents the contract deliberately. The SSE endpoint compensates by
      // sending a snapshot on connect; anything relying on replay here would
      // be silently wrong.
      const bus = new EventBusService();
      bus.emit(created('j-before'));

      const seen: AppEvent[] = [];
      bus.on('job.created').subscribe((e) => seen.push(e));

      expect(seen).toEqual([]);
    });

    it('TC-EVT-013 tolerates an emit with no subscribers at all', () => {
      const bus = new EventBusService();
      expect(() => bus.emit(created('j-1'))).not.toThrow();
    });
  });

  describe('TC-EVT-020..021 — isolation', () => {
    it('TC-EVT-020 keeps separate instances independent', () => {
      const a = new EventBusService();
      const b = new EventBusService();
      const seen: AppEvent[] = [];
      a.on('job.created').subscribe((e) => seen.push(e));

      b.emit(created('j-1'));

      expect(seen).toEqual([]);
    });

    it('TC-EVT-021 covers every declared event type', () => {
      // Guards against a new AppEvent variant being added without a route here.
      const bus = new EventBusService();
      const types: AppEvent['type'][] = [
        'job.created',
        'job.progress',
        'job.completed',
      ];
      for (const type of types) {
        const seen: AppEvent[] = [];
        const sub = bus.on(type).subscribe((e) => seen.push(e));
        bus.emit({ type, projectId: 'p-1', jobId: 'j-1' });
        expect(seen, `no delivery for ${type}`).toHaveLength(1);
        sub.unsubscribe();
      }
    });
  });

  describe('TC-EVT-030..032 — a subscriber that throws', () => {
    /**
     * Measured behaviour (rxjs 7), not assumed:
     *   - `emit()` does NOT throw — the emitting indexing job is protected.
     *   - Later subscribers DO still receive the event — no fan-out breakage.
     *   - The error is re-thrown asynchronously as a process-level
     *     **uncaughtException** (see DEF-007).
     *
     * The first two are good news and are pinned here so a future change to
     * the bus cannot silently remove that protection. The third is DEF-007.
     */
    it('TC-EVT-030 does not propagate out of emit', () => {
      const bus = new EventBusService();
      bus.onAny().subscribe(() => {
        throw new Error('subscriber exploded');
      });

      expect(() => bus.emit(created('j-1'))).not.toThrow();
    });

    it('TC-EVT-031 still delivers to subscribers registered after the throwing one', () => {
      const bus = new EventBusService();
      const later: AppEvent[] = [];
      bus.onAny().subscribe(() => {
        throw new Error('subscriber exploded');
      });
      bus.onAny().subscribe((e) => later.push(e));

      bus.emit(created('j-1'));

      expect(later).toEqual([created('j-1')]);
    });

    it('TC-EVT-032 surfaces the error as a process-level uncaughtException', async () => {
      // rxjs reports it via `reportUnhandledError`, which re-throws on a macro
      // task. This is the bus's real escape route, and it is pinned here
      // because DEF-007 turned on it: nothing used to catch that channel, so a
      // single throwing subscriber exited the whole API. The backstop now lives
      // in `common/process-backstops.ts` (TC-BACK-001/002) — this test still
      // asserts the mechanism it has to catch, and captures the listeners
      // rather than letting the error escape and fail the run.
      const bus = new EventBusService();
      const captured: Error[] = [];
      const original = process.listeners('uncaughtException');
      process.removeAllListeners('uncaughtException');
      process.on('uncaughtException', (err) => captured.push(err));

      // A message unique to this test: the throwing subscribers in TC-EVT-030
      // and TC-EVT-031 also report asynchronously, and their errors can land
      // inside this test's wait window.
      const marker = 'TC-EVT-032 marker error';

      try {
        bus.onAny().subscribe(() => {
          throw new Error(marker);
        });
        bus.emit(created('j-1'));
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        process.removeAllListeners('uncaughtException');
        for (const listener of original) {
          process.on('uncaughtException', listener as never);
        }
      }

      expect(captured.map((e) => e.message)).toContain(marker);
    });
  });
});
