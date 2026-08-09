import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JobsRepository } from '../db/repositories/jobs.repository';
import { IndexCanceledError, IndexingService } from '../indexing/indexing.service';
import { ProgressReporter } from '../indexing/progress.reporter';
import { EmbeddingQuotaExhaustedError } from '../indexing/rate-limiter';
import { EventBusService } from '../events/event-bus.service';
import type { IndexingJobRow } from '../db/schema';

const SAFETY_POLL_MS = 60_000;
const HEARTBEAT_MS = 30_000;
const NUL_BYTE = String.fromCharCode(0);

/**
 * Runs in-process. Wakes on `job.created` instead of polling, so an idle
 * Neon branch can autosuspend; the 60s safety poll only guards against a
 * missed wake-up event.
 */
@Injectable()
export class WorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerService.name);
  private draining = false;
  private safetyPoll?: NodeJS.Timeout;

  constructor(
    private readonly jobsRepository: JobsRepository,
    private readonly indexingService: IndexingService,
    private readonly progressReporter: ProgressReporter,
    private readonly eventBus: EventBusService,
  ) {
    this.eventBus.on('job.created').subscribe(() => {
      void this.drain();
    });
  }

  onModuleInit(): void {
    void this.drain(); // pick up anything left queued from before a restart
    this.safetyPoll = setInterval(() => void this.drain(), SAFETY_POLL_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.safetyPoll);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.jobsRepository.failExceededAttempts();
      let job = await this.jobsRepository.claimNext();
      while (job) {
        const outcome = await this.runJob(job);
        // The daily embedding quota is global, not per-job — if this job just
        // paused on it, every other job needing embedding would hit the same
        // wall immediately. Stop draining for now; the 60s safety poll (or a
        // fresh job.created) will try again later rather than hot-looping.
        if (outcome === 'paused') break;
        job = await this.jobsRepository.claimNext();
      }
    } finally {
      this.draining = false;
    }
  }

  private async runJob(job: IndexingJobRow): Promise<'done' | 'paused'> {
    const heartbeat = setInterval(() => void this.jobsRepository.heartbeat(job.id), HEARTBEAT_MS);
    let outcome: 'done' | 'paused' = 'done';
    try {
      await this.indexingService.indexProject(
        job.projectId,
        this.progressReporter.forJob(job),
        () => this.jobsRepository.isCancelRequested(job.id),
        job.trigger === 'force',
      );
      await this.jobsRepository.markSucceeded(job.id);
    } catch (err) {
      outcome = await this.recordFailure(job, err);
    } finally {
      clearInterval(heartbeat);
    }
    this.eventBus.emit({ type: 'job.completed', projectId: job.projectId, jobId: job.id });
    return outcome;
  }

  private async recordFailure(job: IndexingJobRow, err: unknown): Promise<'done' | 'paused'> {
    if (err instanceof IndexCanceledError) {
      this.logger.log(`Job ${job.id} for project ${job.projectId} canceled: ${err.message}`);
      await this.jobsRepository.markCanceled(job.id);
      return 'done';
    }

    if (err instanceof EmbeddingQuotaExhaustedError) {
      this.logger.warn(`Job ${job.id} for project ${job.projectId} paused: ${err.message}`);
      await this.jobsRepository.markPaused(job.id, err.message);
      return 'paused';
    }

    const rawMessage = err instanceof Error ? err.message : String(err);
    // Postgres text columns can never store a NUL byte; strip it so a failure this
    // ugly (e.g. a source file with an embedded NUL) can still be recorded, not just logged.
    const message = rawMessage.split(NUL_BYTE).join('');
    this.logger.error(`Job ${job.id} for project ${job.projectId} failed: ${message}`);
    try {
      await this.jobsRepository.markFailed(job.id, message);
    } catch (markErr) {
      this.logger.error(
        `Job ${job.id} failed and recording that failure also failed: ${
          markErr instanceof Error ? markErr.message : String(markErr)
        }`,
      );
    }
    return 'done';
  }
}
