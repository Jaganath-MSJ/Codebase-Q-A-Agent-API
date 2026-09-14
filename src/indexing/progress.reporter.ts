import { Injectable } from '@nestjs/common';
import { JobsRepository } from '../db/repositories/jobs.repository';
import { EventBusService } from '../events/event-bus.service';
import type { IndexProgress, OnIndexProgress } from './indexing.service';

// Coalesce the per-file `UPDATE indexing_jobs` to ~this cadence (Phase 12.10) so
// a large repo does O(seconds) progress writes instead of ~filesTotal.
const FLUSH_INTERVAL_MS = 500;

/**
 * Turns indexing progress updates into an immediate in-memory SSE signal plus a
 * coalesced DB write. The SSE stream (progress.controller.ts) reads the job row
 * itself and already audits to ~250 ms, so emitting every update keeps it live
 * while the durable write is throttled. Phase transitions always persist (and
 * flush the previous phase's last update), so the UI shows each phase's final
 * counts; the lease/heartbeat, not this row, owns crash recovery.
 */
@Injectable()
export class ProgressReporter {
  constructor(
    private readonly jobsRepository: JobsRepository,
    private readonly eventBus: EventBusService,
  ) {}

  forJob(job: { id: string; projectId: string }): OnIndexProgress {
    let lastPersistAt = 0;
    let persistedPhase: string | undefined;
    let pending: IndexProgress | undefined; // most recent update not yet written

    const persist = async (update: IndexProgress): Promise<void> => {
      await this.jobsRepository.updateProgress(job.id, update);
      lastPersistAt = Date.now();
      persistedPhase = update.phase;
      pending = undefined;
    };

    return async (update) => {
      // Emit the in-memory signal on every update so SSE stays responsive.
      this.eventBus.emit({
        type: 'job.progress',
        projectId: job.projectId,
        jobId: job.id,
      });

      if (update.phase !== persistedPhase) {
        // Phase transition: flush the previous phase's last (unwritten) update so
        // its completed counts persist, then write the transition itself.
        if (pending) await persist(pending);
        await persist(update);
        return;
      }

      // Same phase: coalesce writes to ~FLUSH_INTERVAL_MS.
      if (Date.now() - lastPersistAt >= FLUSH_INTERVAL_MS) {
        await persist(update);
      } else {
        pending = update;
      }
    };
  }
}
