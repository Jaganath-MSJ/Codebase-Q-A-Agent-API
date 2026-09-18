import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectsService } from '../../src/projects/projects.service';

/**
 * QA round 2 — TC-R2-0xx. The file-read surface of `GET /projects/:id/file`.
 *
 * **Why these run against the real `ProjectsService` and a real temp directory.**
 * Phase 15's L2 suite stubs `ProjectsService` wholesale (see
 * `test/projects.e2e-spec.ts`, which replaces `getFile` with a canned DTO), so
 * every defect living *inside* `getFile` was structurally invisible to it. That
 * is exactly how DEF-015 survived a 1,140-case pass. These tests therefore keep
 * the fakes at the repository boundary and let the service touch a real disk.
 *
 * **These tests pin DEFECTS, not desired behaviour.** Each one asserts what the
 * code does today so the reproduction cannot rot; invert the assertion in the
 * slice that fixes it, exactly as Phase 16 did for its own log. Do not "fix"
 * a failing test here by loosening it — a failure means behaviour moved, which
 * is the signal this file exists to give.
 */

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

let root: string;
let service: ProjectsService;

/** Only the two repository methods `getFile` actually reaches. */
function buildService(workspacePath: string): ProjectsService {
  const projectsRepository = {
    findById: (id: string) =>
      Promise.resolve(
        id === PROJECT_ID
          ? {
              id,
              name: 'QA',
              sourceKind: 'local_path',
              sourceRef: workspacePath,
              workspacePath,
              status: 'ready',
              headRevision: 'rev-1',
            }
          : null,
      ),
  };
  return new ProjectsService(
    projectsRepository as never,
    {} as never,
    {} as never,
    { dataDir: workspacePath } as never,
  );
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'qa-r2-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  // An indexed source file — the only thing a citation can legitimately point at.
  await writeFile(
    path.join(root, 'src', 'a.ts'),
    ['export const a = 1;', 'export const b = 2;', 'export const c = 3;'].join(
      '\n',
    ),
  );
  // A file the walker deliberately excludes from indexing. Its real-world
  // counterpart holds the Neon connection string and the provider API keys.
  await writeFile(
    path.join(root, '.env'),
    'DATABASE_URL=postgres://user:hunter2@example.neon.tech/db\nGOOGLE_API_KEY=AQ.fake-key-for-test\n',
  );
  service = buildService(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('TC-R2-0xx — GET /projects/:id/file read surface', () => {
  it('TC-R2-001 reads an ordinary indexed file at the requested range', async () => {
    const { dto } = await service.getFile(PROJECT_ID, 'src/a.ts', 1, 2, 0);
    expect(dto?.lines).toEqual(['export const a = 1;', 'export const b = 2;']);
  });

  it('TC-R2-002 [SEC] refuses to escape the project root', async () => {
    await expect(
      service.getFile(PROJECT_ID, '../../../../etc/passwd', 1, 2, 0),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('TC-R2-003 [SEC][DEFECT DEF-015] serves a NEVER-INDEXED .env under the project root', async () => {
    // DEF-015 (S2). `getFile` checks containment and nothing else: there is no
    // lookup against `files`/`chunks` to confirm the path is one this project
    // actually indexed. Every secret the walker was careful to exclude is
    // therefore readable through a public GET by anyone who can guess its path.
    //
    // Verified live against the running app on 2026-09-17: a real `api/.env`
    // came back over HTTP 200 with the live database URL and provider keys in
    // the `lines` array.
    //
    // INVERT THIS when DEF-015 is fixed: the call must reject with 404.
    const { dto } = await service.getFile(PROJECT_ID, '.env', 1, 2, 0);
    expect(dto?.lines.join('\n')).toContain('GOOGLE_API_KEY');
    expect(dto?.lines.join('\n')).toContain('hunter2');
  });

  it('TC-R2-004 [DEFECT DEF-016] lets a directory path throw EISDIR instead of returning 404', async () => {
    // DEF-016 (S3). The catch in `getFile` maps exactly one errno — ENOENT.
    // Every other fs failure propagates as an unhandled error, which Nest turns
    // into a bare 500 ("Internal server error"). Reproduced live: a request for
    // a directory returns 500 where a missing file correctly returns 404.
    //
    // INVERT THIS when DEF-016 is fixed: expect a 400/404 HttpException.
    await expect(service.getFile(PROJECT_ID, 'src', 1, 2, 0)).rejects.toThrow();
    await expect(
      service.getFile(PROJECT_ID, 'src', 1, 2, 0),
    ).rejects.not.toMatchObject({ status: 404 });
  });

  it('TC-R2-005 [DEFECT DEF-016] lets a NUL byte in the path throw instead of returning 400', async () => {
    // Same root cause as TC-R2-004. Node rejects a path containing a NUL with
    // ERR_INVALID_ARG_VALUE; it is not ENOENT, so it escapes as a 500.
    const withNul = 'src/a.ts' + String.fromCharCode(0) + '.png';
    await expect(
      service.getFile(PROJECT_ID, withNul, 1, 2, 0),
    ).rejects.toThrow();
  });

  it('TC-R2-006 a missing file is still correctly a 404', async () => {
    // The one errno that IS handled — kept alongside the defect pins so a fix
    // for DEF-016 cannot regress the case that already worked.
    await expect(
      service.getFile(PROJECT_ID, 'src/missing.ts', 1, 2, 0),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('TC-R2-007 an unknown project id is a 404 before any disk access', async () => {
    await expect(
      service.getFile(
        '00000000-0000-4000-8000-000000000000',
        'src/a.ts',
        1,
        2,
        0,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('TC-R2-008 a matching If-None-Match returns the etag with no body', async () => {
    const first = await service.getFile(PROJECT_ID, 'src/a.ts', 1, 2, 0);
    const second = await service.getFile(
      PROJECT_ID,
      'src/a.ts',
      1,
      2,
      0,
      first.etag,
    );
    expect(second.dto).toBeNull();
    expect(second.etag).toBe(first.etag);
  });

  it('TC-R2-009 [INV-9] the returned window indexes the line array 1-based and inclusive', async () => {
    const { dto } = await service.getFile(PROJECT_ID, 'src/a.ts', 2, 3, 0);
    expect(dto?.lines).toEqual(['export const b = 2;', 'export const c = 3;']);
    expect(dto?.contextStart).toBe(2);
    expect(dto?.contextEnd).toBe(3);
  });

  it('TC-R2-010 an end line past EOF clamps rather than padding', async () => {
    const { dto } = await service.getFile(PROJECT_ID, 'src/a.ts', 1, 999, 0);
    expect(dto?.lines).toHaveLength(3);
    expect(dto?.contextEnd).toBe(3);
  });
});
