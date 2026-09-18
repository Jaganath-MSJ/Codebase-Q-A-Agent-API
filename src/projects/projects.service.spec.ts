import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectsService } from './projects.service';
import type { ProjectsRepository } from '../db/repositories/projects.repository';
import type { CredentialsService } from '../credentials/credentials.service';
import type { StorageRepository } from '../db/repositories/storage.repository';
import type { FilesRepository } from '../db/repositories/files.repository';
import type { ConfigService } from '../config/config.service';

const REV = 'rev-abc';

// The exact strong-validator formula the service uses (Phase 13.6).
const etagFor = (marker: string, p: string, s: number, e: number, c: number) =>
  `"${createHash('sha256').update(`${marker}|${p}|${s}|${e}|${c}`).digest('hex').slice(0, 32)}"`;

function build(project: Record<string, unknown> | null) {
  const projectsRepository = {
    findById: vi.fn().mockResolvedValue(project),
  } as unknown as ProjectsRepository;
  // Since the DEF-015 fix every read is gated on the path being in the
  // project's index. These tests are about the ETag and the 200 read path, so
  // the gate is held open here deliberately — the gate's own behaviour is
  // covered in `test/round-2/file-read-surface.spec.ts`.
  const filesRepository = {
    existsByPath: vi.fn().mockResolvedValue(true),
  } as unknown as FilesRepository;
  return new ProjectsService(
    projectsRepository,
    {} as CredentialsService,
    {} as StorageRepository,
    {} as ConfigService,
    filesRepository,
  );
}

describe('ProjectsService.getFile ETag (Phase 13.6)', () => {
  it('short-circuits a matching If-None-Match to a 304 (null dto) without reading disk', async () => {
    // workspacePath is a path that does not exist — if the short-circuit failed
    // and it tried to read the file, this would throw instead of returning null.
    const svc = build({
      id: 'p1',
      headRevision: REV,
      workspacePath: '/nonexistent/root',
      sourceRef: '/nonexistent/root',
    });
    const etag = etagFor(REV, 'a.ts', 1, 5, 20);
    const result = await svc.getFile('p1', 'a.ts', 1, 5, 20, etag);
    expect(result).toEqual({ etag, dto: null });
  });

  it('varies the ETag by range and by revision', async () => {
    expect(etagFor(REV, 'a.ts', 1, 5, 20)).not.toBe(
      etagFor(REV, 'a.ts', 10, 20, 20),
    );
    expect(etagFor(REV, 'a.ts', 1, 5, 20)).not.toBe(
      etagFor('rev-def', 'a.ts', 1, 5, 20),
    );
    // And the service returns exactly that formula's value on a matching request.
    const svc = build({
      id: 'p1',
      headRevision: 'rev-def',
      workspacePath: '/nonexistent',
      sourceRef: '/nonexistent',
    });
    const etag = etagFor('rev-def', 'b.ts', 3, 9, 20);
    expect((await svc.getFile('p1', 'b.ts', 3, 9, 20, etag)).etag).toBe(etag);
  });

  it('throws NotFound for an unknown project', async () => {
    const svc = build(null);
    await expect(
      svc.getFile('missing', 'a.ts', 1, 5, 20, undefined),
    ).rejects.toThrow(/not found/i);
  });
});

describe('ProjectsService.getFile 200 path (real file)', () => {
  let root: string;
  const content = [
    'L1',
    'L2',
    'L3',
    'L4',
    'L5',
    'L6',
    'L7',
    'L8',
    'L9',
    'L10',
  ].join('\n');

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'cqa-getfile-'));
    await writeFile(join(root, 'f.ts'), content, 'utf8');
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads the file and returns the windowed dto plus a matching etag', async () => {
    const svc = build({
      id: 'p1',
      headRevision: REV,
      workspacePath: root,
      sourceRef: root,
    });
    const { etag, dto } = await svc.getFile('p1', 'f.ts', 3, 5, 1);
    expect(etag).toBe(etagFor(REV, 'f.ts', 3, 5, 1));
    // context=1 around lines 3-5 → window is lines 2..6 (1-based inclusive).
    expect(dto).toEqual({
      path: 'f.ts',
      startLine: 3,
      endLine: 5,
      contextStart: 2,
      contextEnd: 6,
      lines: ['L2', 'L3', 'L4', 'L5', 'L6'],
    });
  });

  it('clamps the context window to the file bounds', async () => {
    const svc = build({
      id: 'p1',
      headRevision: REV,
      workspacePath: root,
      sourceRef: root,
    });
    const { dto } = await svc.getFile('p1', 'f.ts', 1, 10, 20);
    expect(dto).toMatchObject({ contextStart: 1, contextEnd: 10 });
    expect(dto!.lines).toHaveLength(10);
  });
});
