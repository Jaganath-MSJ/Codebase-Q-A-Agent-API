import { Injectable } from '@nestjs/common';
import { JobsRepository } from '../db/repositories/jobs.repository';
import { EventBusService } from '../events/event-bus.service';
import type { OnIndexProgress } from './indexing.service';

/**
 * Turns each indexing progress update into a DB write followed by an event
 * publish, so SSE subscribers always see state that is already durable.
 */
@Injectable()
export class ProgressReporter {
  constructor(
    private readonly jobsRepository: JobsRepository,
    private readonly eventBus: EventBusService,
  ) {}

  forJob(job: { id: string; projectId: string }): OnIndexProgress {
    return async (update) => {
      await this.jobsRepository.updateProgress(job.id, update);
      this.eventBus.emit({ type: 'job.progress', projectId: job.projectId, jobId: job.id });
    };
  }
}
