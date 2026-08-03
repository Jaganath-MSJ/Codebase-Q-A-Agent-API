import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { EventEmitter } from 'node:events';
import { JobsRepository } from '../db/repositories/jobs.repository';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import type { IndexingJobRow } from '../db/schema';
import { JOB_CREATED_EVENT, JOB_EVENTS_TOKEN } from './job-events';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const candidate = err as { code?: string; cause?: unknown };
  return candidate.code ?? pgErrorCode(candidate.cause);
}

function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23505';
}

@Injectable()
export class JobsService {
  constructor(
    private readonly jobsRepository: JobsRepository,
    private readonly projectsRepository: ProjectsRepository,
    @Inject(JOB_EVENTS_TOKEN) private readonly events: EventEmitter,
  ) {}

  async enqueue(projectId: string, trigger = 'initial'): Promise<IndexingJobRow> {
    const project = await this.projectsRepository.findById(projectId);
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    try {
      const job = await this.jobsRepository.enqueue(projectId, trigger);
      this.events.emit(JOB_CREATED_EVENT);
      return job;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`Project ${projectId} already has an active indexing job`);
      }
      throw err;
    }
  }

  async findLatest(projectId: string): Promise<IndexingJobRow | undefined> {
    return this.jobsRepository.findLatestByProject(projectId);
  }
}
