import { describe, it, expect, beforeEach } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { EventBusService } from '../events/event-bus.service';
import type { JobsRepository } from '../db/repositories/jobs.repository';
import type { ProjectsRepository } from '../db/repositories/projects.repository';
import type { IndexingJobRow } from '../db/schema';
import type { AppEvent } from '../events/event.types';

/**
 * QA pass — TC-JOB-*.
 *
 * The interesting behaviour is error translation. A partial-unique index stops
 * a project having two active jobs, so the *database* is what enforces the
 * rule — and the race is real: two clicks on "Re-index" land together and one
 * must become a clean 409 rather than a 500. The unique-violation code can
 * arrive wrapped in a driver `cause` chain, which is why the lookup recurses.
 */

const PROJECT_ID = 'p-1';

const job = (id = 'j-1', projectId = PROJECT_ID): IndexingJobRow =>
  ({ id, projectId, status: 'queued' }) as unknown as IndexingJobRow;

function harness(
  options: {
    project?: unknown;
    enqueueError?: unknown;
    enqueued?: IndexingJobRow;
  } = {},
) {
  const {
    project = { id: PROJECT_ID },
    enqueueError,
    enqueued = job(),
  } = options;
  const events: AppEvent[] = [];

  const jobsRepository = {
    enqueue: () => {
      // The injected failure is intentionally `unknown`: TC-JOB-026 rejects
      // with a bare string to prove a non-object rejection is not misread as
      // a conflict.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      if (enqueueError) return Promise.reject(enqueueError);
      return Promise.resolve(enqueued);
    },
    findLatestByProject: () => Promise.resolve(enqueued),
    findLatestByProjectIds: (ids: string[]) =>
      Promise.resolve(ids.map((id) => job(`job-for-${id}`, id))),
    requestCancel: (jobId: string) =>
      Promise.resolve(jobId === 'j-1' ? 'canceling' : null),
  } as unknown as JobsRepository;

  const projectsRepository = {
    findById: (id: string) =>
      Promise.resolve(id === PROJECT_ID ? project : null),
  } as unknown as ProjectsRepository;

  const eventBus = new EventBusService();
  eventBus.onAny().subscribe((e) => events.push(e));

  return {
    service: new JobsService(jobsRepository, projectsRepository, eventBus),
    events,
  };
}

/** A pg unique-violation, optionally buried under `cause` wrappers. */
function uniqueViolation(depth = 0): Error {
  let err: unknown = Object.assign(new Error('duplicate key value'), {
    code: '23505',
  });
  for (let i = 0; i < depth; i++) {
    err = Object.assign(new Error('wrapped by the driver'), { cause: err });
  }
  return err as Error;
}

describe('JobsService.enqueue', () => {
  describe('TC-JOB-001..004 — happy path', () => {
    it('TC-JOB-001 returns the enqueued job', async () => {
      const { service } = harness();
      expect(await service.enqueue(PROJECT_ID)).toEqual(job());
    });

    it('TC-JOB-002 emits job.created so the worker wakes immediately', async () => {
      const { service, events } = harness();
      await service.enqueue(PROJECT_ID);
      expect(events).toEqual([
        { type: 'job.created', projectId: PROJECT_ID, jobId: 'j-1' },
      ]);
    });

    it('TC-JOB-003 defaults the trigger to "initial"', async () => {
      let captured: string | undefined;
      const jobsRepository = {
        enqueue: (_p: string, trigger: string) => {
          captured = trigger;
          return Promise.resolve(job());
        },
      } as unknown as JobsRepository;
      const service = new JobsService(
        jobsRepository,
        {
          findById: () => Promise.resolve({ id: PROJECT_ID }),
        } as unknown as ProjectsRepository,
        new EventBusService(),
      );

      await service.enqueue(PROJECT_ID);
      expect(captured).toBe('initial');
    });

    it('TC-JOB-004 forwards an explicit trigger', async () => {
      let captured: string | undefined;
      const jobsRepository = {
        enqueue: (_p: string, trigger: string) => {
          captured = trigger;
          return Promise.resolve(job());
        },
      } as unknown as JobsRepository;
      const service = new JobsService(
        jobsRepository,
        {
          findById: () => Promise.resolve({ id: PROJECT_ID }),
        } as unknown as ProjectsRepository,
        new EventBusService(),
      );

      await service.enqueue(PROJECT_ID, 'force');
      expect(captured).toBe('force');
    });
  });

  describe('TC-JOB-010..012 — unknown project', () => {
    it('TC-JOB-010 throws NotFound', async () => {
      const { service } = harness();
      await expect(service.enqueue('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('TC-JOB-011 names the project in the message', async () => {
      const { service } = harness();
      await expect(service.enqueue('missing')).rejects.toThrow(
        /Project missing not found/,
      );
    });

    it('TC-JOB-012 emits no event for an unknown project', async () => {
      const { service, events } = harness();
      await expect(service.enqueue('missing')).rejects.toThrow();
      expect(events).toEqual([]);
    });
  });

  describe('TC-JOB-020..026 — duplicate active job (CONC)', () => {
    it('TC-JOB-020 translates a unique violation into 409 Conflict', async () => {
      const { service } = harness({ enqueueError: uniqueViolation() });
      await expect(service.enqueue(PROJECT_ID)).rejects.toThrow(
        ConflictException,
      );
    });

    it('TC-JOB-021 explains the conflict in the message', async () => {
      const { service } = harness({ enqueueError: uniqueViolation() });
      await expect(service.enqueue(PROJECT_ID)).rejects.toThrow(
        /already has an active indexing job/,
      );
    });

    it('TC-JOB-022 finds the code one level down a cause chain', async () => {
      const { service } = harness({ enqueueError: uniqueViolation(1) });
      await expect(service.enqueue(PROJECT_ID)).rejects.toThrow(
        ConflictException,
      );
    });

    it('TC-JOB-023 finds the code several levels down a cause chain', async () => {
      const { service } = harness({ enqueueError: uniqueViolation(4) });
      await expect(service.enqueue(PROJECT_ID)).rejects.toThrow(
        ConflictException,
      );
    });

    it('TC-JOB-024 emits no event when the insert conflicted', async () => {
      const { service, events } = harness({ enqueueError: uniqueViolation() });
      await expect(service.enqueue(PROJECT_ID)).rejects.toThrow();
      expect(events).toEqual([]);
    });

    it('TC-JOB-025 rethrows a non-unique database error unchanged', async () => {
      const other = Object.assign(new Error('connection reset'), {
        code: 'ECONNRESET',
      });
      const { service } = harness({ enqueueError: other });
      await expect(service.enqueue(PROJECT_ID)).rejects.toThrow(
        /connection reset/,
      );
      await expect(service.enqueue(PROJECT_ID)).rejects.not.toBeInstanceOf(
        ConflictException,
      );
    });

    it('TC-JOB-026 tolerates a non-object rejection without misreporting a conflict', async () => {
      const { service } = harness({ enqueueError: 'just a string' });
      await expect(service.enqueue(PROJECT_ID)).rejects.not.toBeInstanceOf(
        ConflictException,
      );
    });

    it('TC-JOB-027 does not treat a null cause as a conflict', async () => {
      const err = Object.assign(new Error('boom'), { cause: null });
      const { service } = harness({ enqueueError: err });
      await expect(service.enqueue(PROJECT_ID)).rejects.toThrow(/boom/);
    });
  });
});

describe('JobsService — reads and cancel', () => {
  let service: JobsService;

  beforeEach(() => {
    ({ service } = harness());
  });

  it('TC-JOB-030 returns the latest job for a project', async () => {
    expect(await service.findLatest(PROJECT_ID)).toEqual(job());
  });

  it('TC-JOB-031 keys the batch lookup by projectId', async () => {
    const map = await service.findLatestForProjects(['p-1', 'p-2', 'p-3']);
    expect([...map.keys()].sort()).toEqual(['p-1', 'p-2', 'p-3']);
    expect(map.get('p-2')!.id).toBe('job-for-p-2');
  });

  it('TC-JOB-032 returns an empty map for no project ids', async () => {
    expect((await service.findLatestForProjects([])).size).toBe(0);
  });

  it('TC-JOB-033 passes a cancel request through', async () => {
    expect(await service.cancel('j-1')).toBe('canceling');
  });

  it('TC-JOB-034 returns null when there is nothing to cancel', async () => {
    expect(await service.cancel('already-done')).toBeNull();
  });
});
