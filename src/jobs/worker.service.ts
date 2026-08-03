import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { EventEmitter } from 'node:events';
import { JobsRepository } from '../db/repositories/jobs.repository';
import { IndexingService } from '../indexing/indexing.service';
import type { IndexingJobRow } from '../db/schema';
import { JOB_CREATED_EVENT, JOB_EVENTS_TOKEN } from './job-events';

const SAFETY_POLL_MS = 60_000;

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
    @Inject(JOB_EVENTS_TOKEN) private readonly events: EventEmitter,
  ) {
    this.events.on(JOB_CREATED_EVENT, () => {
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
      let job = await this.jobsRepository.claimNext();
      while (job) {
        await this.runJob(job);
        job = await this.jobsRepository.claimNext();
      }
    } finally {
      this.draining = false;
    }
  }

  private async runJob(job: IndexingJobRow): Promise<void> {
    try {
      await this.indexingService.indexProject(job.projectId, (filesDone, filesTotal) =>
        this.jobsRepository.updateProgress(job.id, { filesDone, filesTotal }),
      );
      await this.jobsRepository.markSucceeded(job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Job ${job.id} for project ${job.projectId} failed: ${message}`);
      await this.jobsRepository.markFailed(job.id, message);
    }
  }
}
