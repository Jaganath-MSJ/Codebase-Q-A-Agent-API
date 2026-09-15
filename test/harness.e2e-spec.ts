import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHarness, json, VALID_UUID, type Harness } from './harness';
import { ProjectsService } from '../src/projects/projects.service';
import { WorkerService } from '../src/jobs/worker.service';
import { GitPollService } from '../src/jobs/git-poll.service';
import { WatcherService } from '../src/jobs/watcher.service';

/**
 * QA pass — TC-API-000..009.
 *
 * Verifies the harness itself before anything is built on it. Every other L2
 * assertion is only meaningful if these hold: a harness that quietly failed to
 * install the global ValidationPipe would make a dozen "rejects bad input"
 * tests pass for entirely the wrong reason.
 */
describe('L2 harness', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({
      repos: {
        projects: {
          findAll: () => Promise.resolve([]),
          // Enough for TC-API-003's transform check to reach a real 200 rather
          // than dying at the service layer, which would let the assertion
          // pass for the wrong reason.
          findById: () =>
            Promise.resolve({
              id: VALID_UUID,
              headRevision: 'rev-1',
              workspacePath: '/nonexistent',
            }),
        },
        jobs: { findLatestByProjectIds: () => Promise.resolve([]) },
      },
      overrides: [
        {
          provide: ProjectsService,
          useValue: {
            getFile: () =>
              Promise.resolve({
                etag: '"abc"',
                dto: {
                  path: 'a.ts',
                  startLine: 1,
                  endLine: 2,
                  contextStart: 1,
                  contextEnd: 2,
                  lines: ['a', 'b'],
                },
              }),
            findAll: () => Promise.resolve([]),
          },
        },
      ],
    });
  });

  afterAll(async () => {
    await h.close();
  });

  it('TC-API-000 boots the real app and serves under the /api global prefix', async () => {
    const prefixed = await h.request('/projects');
    expect(prefixed.status).toBe(200);

    // Same route without the prefix must not exist — proves setGlobalPrefix ran.
    const unprefixed = await fetch(h.url.replace(/\/api$/, '') + '/projects');
    expect(unprefixed.status).toBe(404);
  });

  it('TC-API-001 has the global ValidationPipe active (missing required field → 400)', async () => {
    const res = await h.request('/projects', json({}));
    expect(res.status).toBe(400);
  });

  it('TC-API-002 has forbidNonWhitelisted active (unknown property → 400)', async () => {
    // THE load-bearing harness assertion. Without forbidNonWhitelisted this
    // returns 201 and every "rejects unknown property" test below is vacuous.
    const res = await h.request(
      '/projects',
      json({ name: 'x', sourceRef: '/tmp/x', unexpectedExtra: 'boom' }),
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/unexpectedExtra/);
  });

  it('TC-API-003 has transform active (query strings coerce to numbers)', async () => {
    // FileQueryDto declares @Type(() => Number) + @IsInt on startLine. Every
    // query-string value arrives as a string, so without `transform` the
    // literal "1" fails IsInt and this is a 400.
    const res = await h.request(
      `/projects/${VALID_UUID}/file?path=a.ts&startLine=1&endLine=2`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ path: 'a.ts', lines: ['a', 'b'] });
  });

  it('TC-API-004 rejects a malformed UUID path param with 400, not 500', async () => {
    const res = await h.request('/projects/not-a-uuid/storage');
    expect(res.status).toBe(400);
  });

  it('TC-API-005 returns JSON error bodies in Nest’s standard shape', async () => {
    const res = await h.request('/projects', json({}));
    const body = res.body as { statusCode: number; message: unknown };
    expect(body.statusCode).toBe(400);
    expect(body.message).toBeDefined();
  });

  it('TC-API-006 runs with no real database — repositories are fakes', async () => {
    // If the real DbModule were still wired, boot would have attempted a
    // connection and migrations against DATABASE_URL.
    const res = await h.request('/projects');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('TC-API-007 does not start the background workers', () => {
    // WorkerService/GitPollService/WatcherService each set an interval and hit
    // the DB, the network or fs.watch on init. Resolve them from the running
    // container and confirm each is the inert stub rather than the real class —
    // if an override silently stopped applying, a leaked interval would keep
    // the process alive past the suite and hammer a database that isn't there.
    for (const token of [WorkerService, GitPollService, WatcherService]) {
      const instance = h.app.get<object>(token);
      expect(instance, token.name).not.toBeInstanceOf(token);
      expect(instance).toHaveProperty('onModuleInit');
    }
  });

  it('TC-API-008 serves an unknown route as 404', async () => {
    const res = await h.request('/no-such-route');
    expect(res.status).toBe(404);
  });

  it('TC-API-009 rejects a malformed JSON body with 400', async () => {
    const res = await h.request('/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not valid json',
    });
    expect(res.status).toBe(400);
  });
});
