import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectsService } from '../../src/projects/projects.service';

/**
 * QA round 2 — TC-R2-2xx. `POST /projects` source validation, DEF-018.
 *
 * **Why this is a service test and not an L2 contract test.** The rule is
 * conditional on `sourceKind`, so it lives in `ProjectsService.create` beside
 * the pre-existing `zip_upload` check rather than in the DTO. The L2 harness
 * stubs `ProjectsService` wholesale, so it cannot see this at all — the same
 * structural blind spot that let DEF-015 survive its QA pass. These run the real
 * service against a real temp directory, with fakes only at the repository
 * boundary.
 */

let root: string;
let fileNotDir: string;
let service: ProjectsService;
let created: Record<string, unknown> | undefined;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'qa-r2-create-'));
  await mkdir(path.join(root, 'repo'), { recursive: true });
  fileNotDir = path.join(root, 'a-file.txt');
  await writeFile(fileNotDir, 'not a directory');

  const projectsRepository = {
    create: (row: Record<string, unknown>) => {
      created = row;
      return Promise.resolve({ id: 'p-1', ...row });
    },
  };
  service = new ProjectsService(
    projectsRepository as never,
    {} as never,
    {} as never,
    { dataDir: root } as never,
    {} as never,
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('TC-R2-2xx — POST /projects source validation (DEF-018)', () => {
  it('TC-R2-200 accepts an absolute path to a real directory', async () => {
    created = undefined;
    const row = await service.create({
      name: 'ok',
      sourceKind: 'local_path',
      sourceRef: path.join(root, 'repo'),
    });
    expect(row).toMatchObject({ id: 'p-1' });
    expect(created?.sourceRef).toBe(path.join(root, 'repo'));
  });

  it('TC-R2-201 [DEF-018 FIXED][INV-2] rejects a RELATIVE local_path', async () => {
    // DEF-018 (S3), found 2026-09-17, fixed 2026-09-18. CLAUDE.md is explicit
    // that `workspace_path`/`source_ref` for a local_path project is a native
    // **absolute** machine path — it is the root every repo-relative path in
    // the system resolves against. Nothing enforced it, so './fixtures/tiny-repo'
    // was accepted and indexed (verified live: 11 files, 12 chunks, ready),
    // resolved against whatever the API process's cwd happened to be.
    //
    // The row then means something different the moment the server starts from
    // elsewhere: the viewer 404s, or — where two roots share a relative path —
    // serves a *different* file under a citation that still looks valid.
    //
    // This assertion was inverted as part of the fix.
    await expect(
      service.create({
        name: 'rel',
        sourceKind: 'local_path',
        sourceRef: './fixtures/tiny-repo',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('TC-R2-202 [DEF-018] rejects a bare relative name with no ./ prefix', async () => {
    // `path.isAbsolute` is the check, so this is covered by construction — but
    // it is the form a user is most likely to paste, so it is asserted rather
    // than assumed.
    await expect(
      service.create({
        name: 'bare',
        sourceKind: 'local_path',
        sourceRef: 'fixtures/tiny-repo',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('TC-R2-203 [DEF-018 FIXED] rejects a path that does not exist', async () => {
    // Previously accepted, failing later as a queued job with
    // "Local path is not readable". Now a 400 at create time — the same
    // reasoning the zip_upload check already applied: a typo should not cost a
    // job the user has to go and look at.
    await expect(
      service.create({
        name: 'ghost',
        sourceKind: 'local_path',
        sourceRef: path.join(root, 'no', 'such', 'dir'),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('TC-R2-204 [DEF-018 FIXED] rejects a file where a directory is required', async () => {
    // Previously accepted, then failed mid-index with a raw
    // "ENOTDIR: not a directory, scandir '<absolute host path>'" in the job's
    // errorMessage — an fs errno string on a client-facing surface.
    await expect(
      service.create({
        name: 'file',
        sourceKind: 'local_path',
        sourceRef: fileNotDir,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('TC-R2-205 the check is scoped to local_path and does not touch git_url', async () => {
    // git_url refs are validated at materialize time by the adapter
    // ("Not a valid GitHub HTTPS URL"), which is a deliberate split: that one
    // needs the network, this one does not. Widening the new check to every
    // source kind would break that.
    created = undefined;
    await service.create({
      name: 'git',
      sourceKind: 'git_url',
      sourceRef: 'https://github.com/octocat/Hello-World.git',
    });
    expect(created?.sourceRef).toBe(
      'https://github.com/octocat/Hello-World.git',
    );
  });

  it('TC-R2-206 git_private still requires a token', async () => {
    await expect(
      service.create({
        name: 'priv',
        sourceKind: 'git_private',
        sourceRef: 'https://github.com/octocat/Hello-World.git',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
