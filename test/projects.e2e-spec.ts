import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import {
  createHarness,
  json,
  UNKNOWN_UUID,
  VALID_UUID,
  type Harness,
} from './harness';
import { ProjectsService } from '../src/projects/projects.service';
import { JobsService } from '../src/jobs/jobs.service';
import { IndexingService } from '../src/indexing/indexing.service';

/**
 * QA pass — TC-API-1xx (projects) and TC-API-2xx (jobs).
 *
 * The contract layer: status codes, validation rejection, and response shape.
 * These nine routes had no coverage of any kind before this slice.
 *
 * Note the shape of the negative cases. `forbidNonWhitelisted` and
 * `ParseUUIDPipe` were both added in Phase 14.2 specifically so malformed input
 * becomes a 400 instead of a 500 or a silent accept; each now has a test that
 * fails loudly if that regresses.
 */

const NOW = new Date('2026-01-01T00:00:00.000Z');

const projectRow = (over: Record<string, unknown> = {}) => ({
  id: VALID_UUID,
  name: 'Demo',
  sourceKind: 'local_path',
  sourceRef: '/Users/someone/secret-path/demo',
  workspacePath: '/Users/someone/secret-path/demo',
  status: 'ready',
  fileCount: 12,
  chunkCount: 40,
  overview: 'a digest',
  headRevision: 'rev-1',
  createdAt: NOW,
  ...over,
});

const jobRow = (over: Record<string, unknown> = {}) => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId: VALID_UUID,
  status: 'queued',
  phase: null,
  trigger: 'initial',
  attempt: 0,
  filesTotal: 0,
  filesDone: 0,
  filesSkipped: 0,
  skipReasons: {},
  chunksTotal: 0,
  chunksEmbedded: 0,
  embedRequests: 0,
  currentPath: null,
  cancelRequested: false,
  errorMessage: null,
  startedAt: null,
  finishedAt: null,
  createdAt: NOW,
  ...over,
});

describe('Projects and jobs routes', () => {
  let h: Harness;
  let created: Record<string, unknown> | undefined;
  let enqueueTrigger: string | undefined;
  let deleted: string | undefined;

  beforeAll(async () => {
    h = await createHarness({
      overrides: [
        {
          provide: ProjectsService,
          useValue: {
            create: (dto: Record<string, unknown>) => {
              created = dto;
              return Promise.resolve(projectRow({ name: dto.name as string }));
            },
            findAll: () => Promise.resolve([projectRow()]),
            getFile: (id: string) => {
              if (id !== VALID_UUID)
                return Promise.reject(new NotFoundException('nope'));
              return Promise.resolve({
                etag: '"deadbeef"',
                dto: {
                  path: 'src/a.ts',
                  startLine: 2,
                  endLine: 3,
                  contextStart: 1,
                  contextEnd: 4,
                  lines: ['one', 'two', 'three', 'four'],
                },
              });
            },
            getStorage: (id: string) => {
              if (id !== VALID_UUID)
                return Promise.reject(new NotFoundException('nope'));
              return Promise.resolve({
                projectId: id,
                workspaceBytes: 1024,
                databaseBytes: 2048,
                sharedIndexBytes: 512,
              });
            },
          },
        },
        {
          provide: JobsService,
          useValue: {
            enqueue: (projectId: string, trigger: string) => {
              if (projectId !== VALID_UUID)
                return Promise.reject(
                  new NotFoundException(`Project ${projectId} not found`),
                );
              enqueueTrigger = trigger;
              return Promise.resolve(jobRow({ trigger }));
            },
            findLatestForProjects: () => Promise.resolve(new Map()),
            findLatest: (projectId: string) =>
              Promise.resolve(projectId === VALID_UUID ? jobRow() : undefined),
            cancel: (jobId: string) =>
              Promise.resolve(
                jobId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
                  ? 'canceling'
                  : null,
              ),
          },
        },
        {
          provide: IndexingService,
          useValue: {
            estimateIndexCost: (id: string) => {
              if (id !== VALID_UUID)
                return Promise.reject(new NotFoundException('nope'));
              return Promise.resolve({
                filesToIndex: 3,
                chunksToEmbed: 10,
                cachedChunks: 2,
                embedRequests: 3,
                dailyQuotaRemaining: 897,
              });
            },
            deleteProject: (id: string) => {
              if (id !== VALID_UUID)
                return Promise.reject(new NotFoundException('nope'));
              deleted = id;
              return Promise.resolve();
            },
          },
        },
      ],
    });
  });

  afterAll(async () => {
    await h.close();
  });

  // ---------------------------------------------------------------- POST /projects

  describe('TC-API-100..112 — POST /projects', () => {
    it('TC-API-100 creates a project and returns 201', async () => {
      const res = await h.request(
        '/projects',
        json({ name: 'Demo', sourceRef: '/tmp/demo' }),
      );
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ id: VALID_UUID, name: 'Demo' });
    });

    it('TC-API-101 passes sourceKind through as undefined when omitted', async () => {
      // The 'local_path' default lives in ProjectsService (`dto.sourceKind ??
      // 'local_path'`), not in the DTO — so the contract here is that the
      // controller forwards `undefined` rather than substituting a value or
      // dropping the key, which is what lets that default apply.
      await h.request('/projects', json({ name: 'D', sourceRef: '/tmp/d' }));
      expect(created!.sourceKind).toBeUndefined();
    });

    it('TC-API-102 accepts every documented sourceKind', async () => {
      for (const sourceKind of [
        'local_path',
        'git_url',
        'zip_upload',
        'git_private',
      ]) {
        const res = await h.request(
          '/projects',
          json({ name: 'D', sourceRef: 'x', sourceKind }),
        );
        expect(res.status, sourceKind).toBe(201);
      }
    });

    it('TC-API-103 rejects an unknown sourceKind', async () => {
      const res = await h.request(
        '/projects',
        json({ name: 'D', sourceRef: 'x', sourceKind: 'svn' }),
      );
      expect(res.status).toBe(400);
    });

    it('TC-API-104 rejects a missing name', async () => {
      const res = await h.request('/projects', json({ sourceRef: '/tmp/x' }));
      expect(res.status).toBe(400);
    });

    it('TC-API-105 rejects an empty name', async () => {
      const res = await h.request(
        '/projects',
        json({ name: '', sourceRef: '/tmp/x' }),
      );
      expect(res.status).toBe(400);
    });

    it('TC-API-106 rejects a missing sourceRef', async () => {
      const res = await h.request('/projects', json({ name: 'D' }));
      expect(res.status).toBe(400);
    });

    it('TC-API-107 rejects a non-string name', async () => {
      const res = await h.request(
        '/projects',
        json({ name: 42, sourceRef: '/tmp/x' }),
      );
      expect(res.status).toBe(400);
    });

    it('TC-API-108 rejects an unknown extra property', async () => {
      const res = await h.request(
        '/projects',
        json({ name: 'D', sourceRef: 'x', isAdmin: true }),
      );
      expect(res.status).toBe(400);
    });

    it('TC-API-109 strips nothing silently — whitelisted fields survive', async () => {
      await h.request(
        '/projects',
        json({ name: 'D', sourceRef: 'x', branch: 'main' }),
      );
      expect(created).toMatchObject({ sourceRef: 'x', branch: 'main' });
    });

    it('TC-API-110 accepts an optional token for git_private', async () => {
      const res = await h.request(
        '/projects',
        json({
          name: 'D',
          sourceRef: 'https://github.com/o/r',
          sourceKind: 'git_private',
          token: 'ghp_secret',
        }),
      );
      expect(res.status).toBe(201);
    });

    it('TC-API-111 never echoes a submitted token back (SEC)', async () => {
      const res = await h.request(
        '/projects',
        json({
          name: 'D',
          sourceRef: 'https://github.com/o/r',
          sourceKind: 'git_private',
          token: 'ghp_super_secret_value',
        }),
      );
      expect(res.text).not.toContain('ghp_super_secret_value');
      expect(res.text).not.toContain('token');
    });

    it('TC-API-112 handles a very long name without a 500', async () => {
      const res = await h.request(
        '/projects',
        json({ name: 'x'.repeat(10_000), sourceRef: '/tmp/x' }),
      );
      expect(res.status).toBeLessThan(500);
    });
  });

  // ----------------------------------------------------------------- GET /projects

  describe('TC-API-120..124 — GET /projects', () => {
    it('TC-API-120 returns the project list', async () => {
      const res = await h.request('/projects');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('TC-API-121 returns the documented ProjectDto shape', async () => {
      const [project] = (await h.request('/projects')).body as Record<
        string,
        unknown
      >[];
      expect(Object.keys(project!).sort()).toEqual([
        'chunkCount',
        'createdAt',
        'fileCount',
        'id',
        'latestJob',
        'name',
        'overview',
        'sourceKind',
        'status',
      ]);
    });

    it('TC-API-122 [INV-2] never leaks sourceRef or an absolute machine path', async () => {
      // Phase 14.1.1 removed `sourceRef` from ProjectDto because it exposed the
      // server's native path (local_path) or a private repo URL. CLAUDE.md
      // states workspace_path/source_ref are server-side only.
      const res = await h.request('/projects');
      expect(res.text).not.toContain('sourceRef');
      expect(res.text).not.toContain('workspacePath');
      expect(res.text).not.toContain('/Users/someone/secret-path');
    });

    it('TC-API-123 serialises createdAt as an ISO string', async () => {
      const [project] = (await h.request('/projects')).body as Record<
        string,
        unknown
      >[];
      expect(project!.createdAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('TC-API-124 includes latestJob as null when a project has never indexed', async () => {
      const [project] = (await h.request('/projects')).body as Record<
        string,
        unknown
      >[];
      expect(project!.latestJob).toBeNull();
    });
  });

  // ---------------------------------------------------- POST /projects/:id/index

  describe('TC-API-130..136 — POST /projects/:id/index', () => {
    it('TC-API-130 enqueues a job and returns 202', async () => {
      const res = await h.request(`/projects/${VALID_UUID}/index`, json({}));
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ projectId: VALID_UUID });
    });

    it('TC-API-131 maps force:true to the "force" trigger', async () => {
      await h.request(`/projects/${VALID_UUID}/index`, json({ force: true }));
      expect(enqueueTrigger).toBe('force');
    });

    it('TC-API-132 maps an omitted force to the "initial" trigger', async () => {
      await h.request(`/projects/${VALID_UUID}/index`, json({}));
      expect(enqueueTrigger).toBe('initial');
    });

    it('TC-API-133 rejects a non-boolean force', async () => {
      const res = await h.request(
        `/projects/${VALID_UUID}/index`,
        json({ force: 'yes' }),
      );
      expect(res.status).toBe(400);
    });

    it('TC-API-134 rejects an unknown extra property', async () => {
      const res = await h.request(
        `/projects/${VALID_UUID}/index`,
        json({ force: true, sneaky: 1 }),
      );
      expect(res.status).toBe(400);
    });

    it('TC-API-135 returns 400 for a malformed project id', async () => {
      const res = await h.request('/projects/not-a-uuid/index', json({}));
      expect(res.status).toBe(400);
    });

    it('TC-API-136 returns 404 for an unknown project', async () => {
      const res = await h.request(`/projects/${UNKNOWN_UUID}/index`, json({}));
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------- GET /projects/:id/cost-estimate

  describe('TC-API-140..142 — GET /projects/:id/cost-estimate', () => {
    it('TC-API-140 returns an estimate', async () => {
      const res = await h.request(`/projects/${VALID_UUID}/cost-estimate`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ filesToIndex: 3, chunksToEmbed: 10 });
    });

    it('TC-API-141 returns 400 for a malformed id', async () => {
      expect((await h.request('/projects/xyz/cost-estimate')).status).toBe(400);
    });

    it('TC-API-142 returns 404 for an unknown project', async () => {
      expect(
        (await h.request(`/projects/${UNKNOWN_UUID}/cost-estimate`)).status,
      ).toBe(404);
    });
  });

  // ------------------------------------------------------ GET /projects/:id/file

  describe('TC-API-150..162 — GET /projects/:id/file', () => {
    const fileUrl = (qs: string) => `/projects/${VALID_UUID}/file?${qs}`;

    it('TC-API-150 returns the file window', async () => {
      const res = await h.request(
        fileUrl('path=src/a.ts&startLine=2&endLine=3'),
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ path: 'src/a.ts', startLine: 2 });
    });

    it('TC-API-151 sets a strong ETag and a revalidating Cache-Control', async () => {
      const res = await h.request(
        fileUrl('path=src/a.ts&startLine=2&endLine=3'),
      );
      expect(res.headers.get('etag')).toBe('"deadbeef"');
      expect(res.headers.get('cache-control')).toBe(
        'private, max-age=0, must-revalidate',
      );
    });

    it('TC-API-152 rejects a backslash path (INV-2)', async () => {
      // FileQueryDto @Matches(/^[^\\]+$/) — paths are forward-slash only.
      const res = await h.request(
        fileUrl('path=src%5Ca.ts&startLine=1&endLine=2'),
      );
      expect(res.status).toBe(400);
    });

    it('TC-API-153 rejects a missing path', async () => {
      expect((await h.request(fileUrl('startLine=1&endLine=2'))).status).toBe(
        400,
      );
    });

    it('TC-API-154 rejects an empty path', async () => {
      expect(
        (await h.request(fileUrl('path=&startLine=1&endLine=2'))).status,
      ).toBe(400);
    });

    it('TC-API-155 rejects a missing startLine', async () => {
      expect((await h.request(fileUrl('path=a.ts&endLine=2'))).status).toBe(
        400,
      );
    });

    it('TC-API-156 rejects startLine below 1', async () => {
      for (const startLine of ['0', '-5']) {
        const res = await h.request(
          fileUrl(`path=a.ts&startLine=${startLine}&endLine=2`),
        );
        expect(res.status, startLine).toBe(400);
      }
    });

    it('TC-API-157 rejects a non-numeric startLine', async () => {
      expect(
        (await h.request(fileUrl('path=a.ts&startLine=abc&endLine=2'))).status,
      ).toBe(400);
    });

    it('TC-API-158 rejects a fractional line number', async () => {
      expect(
        (await h.request(fileUrl('path=a.ts&startLine=1.5&endLine=2'))).status,
      ).toBe(400);
    });

    it('TC-API-159 accepts an explicit context of 0', async () => {
      const res = await h.request(
        fileUrl('path=a.ts&startLine=1&endLine=2&context=0'),
      );
      expect(res.status).toBe(200);
    });

    it('TC-API-160 rejects a negative context', async () => {
      expect(
        (await h.request(fileUrl('path=a.ts&startLine=1&endLine=2&context=-1')))
          .status,
      ).toBe(400);
    });

    it('TC-API-161 rejects an unknown query parameter', async () => {
      expect(
        (await h.request(fileUrl('path=a.ts&startLine=1&endLine=2&evil=1')))
          .status,
      ).toBe(400);
    });

    it('TC-API-162 returns 404 for an unknown project', async () => {
      const res = await h.request(
        `/projects/${UNKNOWN_UUID}/file?path=a.ts&startLine=1&endLine=2`,
      );
      expect(res.status).toBe(404);
    });
  });

  // --------------------------------------------------- GET /projects/:id/storage

  describe('TC-API-170..172 — GET /projects/:id/storage', () => {
    it('TC-API-170 returns the storage report', async () => {
      const res = await h.request(`/projects/${VALID_UUID}/storage`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ workspaceBytes: 1024 });
    });

    it('TC-API-171 returns 400 for a malformed id', async () => {
      expect((await h.request('/projects/nope/storage')).status).toBe(400);
    });

    it('TC-API-172 returns 404 for an unknown project', async () => {
      expect(
        (await h.request(`/projects/${UNKNOWN_UUID}/storage`)).status,
      ).toBe(404);
    });
  });

  // ------------------------------------------------------- DELETE /projects/:id

  describe('TC-API-180..183 — DELETE /projects/:id', () => {
    it('TC-API-180 deletes and returns 204 with no body', async () => {
      const res = await h.request(`/projects/${VALID_UUID}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect(deleted).toBe(VALID_UUID);
    });

    it('TC-API-181 returns 400 for a malformed id', async () => {
      const res = await h.request('/projects/nope', { method: 'DELETE' });
      expect(res.status).toBe(400);
    });

    it('TC-API-182 returns 404 for an unknown project', async () => {
      const res = await h.request(`/projects/${UNKNOWN_UUID}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
    });

    it('TC-API-183 rejects an unsupported method on the collection', async () => {
      const res = await h.request('/projects', { method: 'PATCH' });
      expect(res.status).toBe(404);
    });
  });

  // ------------------------------------- GET /projects/:projectId/jobs/latest

  describe('TC-API-200..203 — GET /projects/:projectId/jobs/latest', () => {
    it('TC-API-200 returns the latest job', async () => {
      const res = await h.request(`/projects/${VALID_UUID}/jobs/latest`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'queued', trigger: 'initial' });
    });

    it('TC-API-201 serialises nullable timestamps as null, not undefined', async () => {
      const body = (await h.request(`/projects/${VALID_UUID}/jobs/latest`))
        .body as Record<string, unknown>;
      expect(body.startedAt).toBeNull();
      expect(body.finishedAt).toBeNull();
      expect(body.createdAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('TC-API-202 returns 404 when the project has never been indexed', async () => {
      const res = await h.request(`/projects/${UNKNOWN_UUID}/jobs/latest`);
      expect(res.status).toBe(404);
    });

    it('TC-API-203 returns 400 for a malformed project id', async () => {
      expect((await h.request('/projects/nope/jobs/latest')).status).toBe(400);
    });
  });

  // --------------------------------------------------- POST /jobs/:jobId/cancel

  describe('TC-API-210..213 — POST /jobs/:jobId/cancel', () => {
    it('TC-API-210 requests cancellation and returns 202', async () => {
      const res = await h.request(
        '/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/cancel',
        { method: 'POST' },
      );
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ status: 'canceling' });
    });

    it('TC-API-211 returns 409 when the job is already terminal', async () => {
      const res = await h.request(`/jobs/${UNKNOWN_UUID}/cancel`, {
        method: 'POST',
      });
      expect(res.status).toBe(409);
    });

    it('TC-API-212 returns 400 for a malformed job id', async () => {
      const res = await h.request('/jobs/nope/cancel', { method: 'POST' });
      expect(res.status).toBe(400);
    });

    it('TC-API-213 is idempotent in effect — a second cancel still answers cleanly', async () => {
      const first = await h.request(
        '/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/cancel',
        { method: 'POST' },
      );
      const second = await h.request(
        '/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/cancel',
        { method: 'POST' },
      );
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
    });
  });
});
