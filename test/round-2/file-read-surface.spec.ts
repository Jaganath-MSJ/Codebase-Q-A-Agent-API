import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectsService } from '../../src/projects/projects.service';
import * as readFileModule from '../../src/common/read-file';

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

/**
 * Only the repository methods `getFile` actually reaches.
 *
 * `indexedPaths` is the set of paths the project is pretending to have indexed
 * — the DEF-015 fix gates every read on membership in `files`, so a test that
 * wants to read a file must list it here. That is the point: `.env` is absent
 * from this set for exactly the reason it is absent from a real index.
 */
const INDEXED_PATHS = new Set(['src/a.ts', 'src/missing.ts', 'src']);

function buildService(workspacePath: string): ProjectsService {
  const filesRepository = {
    existsByPath: (_projectId: string, path: string) =>
      Promise.resolve(INDEXED_PATHS.has(path)),
  };
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
    filesRepository as never,
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

  it('TC-R2-003 [SEC][DEF-015 FIXED] refuses a NEVER-INDEXED .env under the project root', async () => {
    // DEF-015 (S2), found 2026-09-17, fixed 2026-09-18. `getFile` used to check
    // containment and nothing else — no lookup against `files` to confirm the
    // path was one this project actually indexed — so every secret the walker
    // was careful to exclude was readable through a plain GET by anyone who
    // could guess its path. Verified live at the time: a real `api/.env` came
    // back as HTTP 200 with the live database URL and provider keys in `lines`.
    //
    // This assertion was inverted as part of the fix. It now proves the gate
    // holds: `.env` exists on disk under the root and is readable, and the only
    // reason it is refused is that it is not in `INDEXED_PATHS`.
    await expect(
      service.getFile(PROJECT_ID, '.env', 1, 2, 0),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('TC-R2-011 [SEC][DEF-015] the refusal is membership, not existence', async () => {
    // The distinction worth pinning: the file is present, readable, and inside
    // the root — `resolveInside` is perfectly happy with it. Only the index
    // lookup refuses it. If someone later "simplifies" the fix into an
    // existence or extension check, this fails.
    const onDisk = await readFile(path.join(root, '.env'), 'utf8');
    expect(onDisk).toContain('GOOGLE_API_KEY');

    await expect(
      service.getFile(PROJECT_ID, '.env', 1, 2, 0),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('TC-R2-012 [SEC][DEF-015] an unindexed path is refused before any ETag is issued', async () => {
    // The check sits ahead of the ETag on purpose. Were it after, a client
    // holding a stale validator for a path that is no longer viewable would get
    // a 304 — cheap, but still an answer about a file it may not see.
    await expect(
      service.getFile(PROJECT_ID, '.env', 1, 2, 0, '"anything"'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('TC-R2-004 [DEF-016 FIXED] a directory where a file was indexed is a 404, not a 500', async () => {
    // DEF-016 (S3), found 2026-09-17, fixed 2026-09-18. The catch in `getFile`
    // mapped exactly one errno — ENOENT — so every other fs failure escaped as
    // a bare 500 "Internal server error".
    //
    // `'src'` is deliberately in INDEXED_PATHS: since the DEF-015 fix an
    // unindexed path is refused before any fs call, so the only way to reach
    // this at all is a path that WAS indexed as a file and is now a directory —
    // a rename between indexing and viewing. That is exactly the stale-index
    // condition the fix maps to 404.
    await expect(
      service.getFile(PROJECT_ID, 'src', 1, 2, 0),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('TC-R2-013 [DEF-016] the 404 names the cause without leaking the absolute path', async () => {
    // The fix has to stay on the right side of the DEF-004 lesson: say enough
    // that the client can act (re-index), without putting the host filesystem
    // layout into a response body.
    const error = await service
      .getFile(PROJECT_ID, 'src', 1, 2, 0)
      .then(() => null)
      .catch((err: Error) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain('EISDIR');
    expect(error!.message).toContain('src');
    // The absolute host path must not appear — only the repo-relative one.
    expect(error!.message).not.toContain(root);
  });

  it('TC-R2-014 [DEF-016] a genuinely unexpected error is still a 500, not flattened to 404', async () => {
    // The half of the fix that is easy to get wrong: mapping *everything* to
    // 404 would hide real server faults. Only the stale-index errnos are
    // translated; an EIO must still surface as a fault.
    const brokenService = buildService(root);
    const io = Object.assign(new Error('disk exploded'), { code: 'EIO' });
    vi.spyOn(readFileModule, 'readSourceFile').mockRejectedValueOnce(io);

    await expect(
      brokenService.getFile(PROJECT_ID, 'src/a.ts', 1, 2, 0),
    ).rejects.toMatchObject({ code: 'EIO' });

    vi.restoreAllMocks();
  });

  it('TC-R2-005 [DEF-016] a NUL byte in the path is a 404, not a 500', async () => {
    // This used to pin DEF-016's second half: Node rejects a path containing a
    // NUL with ERR_INVALID_ARG_VALUE, which is not ENOENT, so it escaped the
    // catch as a bare 500.
    //
    // The DEF-015 membership gate closed it as a side effect — a NUL-bearing
    // path is in no index, so it is refused before `readSourceFile` is ever
    // called. Recorded here rather than deleted, because the underlying
    // errno-mapping defect is still open (TC-R2-004) and someone reading
    // DEF-016 needs to know which half of it this route can still reach.
    const withNul = 'src/a.ts' + String.fromCharCode(0) + '.png';
    await expect(
      service.getFile(PROJECT_ID, withNul, 1, 2, 0),
    ).rejects.toMatchObject({ status: 404 });
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

/**
 * QA round 3 — TC-R3-0xx, the pin for DEF-032.
 *
 * `getFile` resolves against `project.workspacePath ?? project.sourceRef`, and
 * the comment beside that fallback assumed `workspacePath` is "only null for a
 * project that has never been indexed, which has no citations to view yet".
 *
 * A live `git_url` project falsified both halves: it had 4 rendered citations
 * and a null `workspacePath`. `sourceRef` for that kind is a **GitHub URL**,
 * not a directory, so the fallback fabricated a root —
 * `path.resolve('https://github.com/u/r')` is `<cwd>/https:/github.com/u/r` —
 * which passes containment (it is a normal string under cwd) and then ENOENTs.
 *
 * The user-visible result: every citation 404s with "re-index the project",
 * on a project that reports `ready` and whose search works.
 */
describe('TC-R3-0xx — the workspace-root fallback (DEF-032)', () => {
  const unindexedProject = (overrides: Record<string, unknown>) => {
    const filesRepository = {
      // The path IS indexed — this defect lives past the membership gate.
      existsByPath: () => Promise.resolve(true),
    };
    const projectsRepository = {
      findById: (id: string) =>
        Promise.resolve(
          id === PROJECT_ID
            ? {
                id,
                name: 'QA',
                status: 'ready',
                headRevision: 'rev-1',
                ...overrides,
              }
            : null,
        ),
    };
    return new ProjectsService(
      projectsRepository as never,
      {} as never,
      {} as never,
      { dataDir: root } as never,
      filesRepository as never,
    );
  };

  it('TC-R3-001 [DEF-032 FIXED] a git_url project with no workspace says so, instead of ENOENT', async () => {
    // Before the fix this was a 404 "File is no longer readable (ENOENT) —
    // re-index the project", which names the wrong cause: nothing was ever
    // materialised, so there is no stale index to refresh and no file that
    // stopped being readable.
    const service = unindexedProject({
      sourceKind: 'git_url',
      sourceRef: 'https://github.com/someuser/somerepo',
      workspacePath: null,
    });
    await expect(
      service.getFile(PROJECT_ID, 'README.md', 1, 55, 0),
    ).rejects.toMatchObject({ status: 404 });

    const err = await service
      .getFile(PROJECT_ID, 'README.md', 1, 55, 0)
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/not been indexed/i);
    // INV-2: the fabricated host path must not leak either.
    expect((err as Error).message).not.toMatch(/github\.com/);
    expect((err as Error).message).not.toMatch(process.cwd());
  });

  it('TC-R3-002 [DEF-032] the same holds for zip_upload, whose sourceRef is an upload id', async () => {
    const service = unindexedProject({
      sourceKind: 'zip_upload',
      sourceRef: 'upload-abc123',
      workspacePath: null,
    });
    const err = await service
      .getFile(PROJECT_ID, 'README.md', 1, 5, 0)
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/not been indexed/i);
  });

  it('TC-R3-003 [DEF-032] local_path still falls back to sourceRef, which IS a directory', async () => {
    // The fallback is correct for exactly one source kind, and that must keep
    // working — a local_path project's sourceRef is the native absolute path
    // the repo-relative paths resolve against (CLAUDE.md, INV-2's exception).
    const service = unindexedProject({
      sourceKind: 'local_path',
      sourceRef: root,
      workspacePath: null,
    });
    const { dto } = await service.getFile(PROJECT_ID, 'src/a.ts', 1, 2, 0);
    expect(dto?.lines).toEqual(['export const a = 1;', 'export const b = 2;']);
  });

  it('TC-R3-004 [DEF-032] a materialised workspace is unaffected', async () => {
    const service = unindexedProject({
      sourceKind: 'git_url',
      sourceRef: 'https://github.com/someuser/somerepo',
      workspacePath: root,
    });
    const { dto } = await service.getFile(PROJECT_ID, 'src/a.ts', 1, 2, 0);
    expect(dto?.lines).toEqual(['export const a = 1;', 'export const b = 2;']);
  });
});
