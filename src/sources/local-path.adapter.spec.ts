import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NotFoundException } from '@nestjs/common';
import { LocalPathAdapter, REVISION_IGNORE_GLOBS } from './local-path.adapter';
import type { ProjectRow } from '../db/schema';

/**
 * QA pass — TC-LPA-*.
 *
 * The revision hash decides whether indexing does any work at all. Two failure
 * directions: a revision that changes when nothing did (wasted re-index) and a
 * revision that stays the same when content changed (a stale index that looks
 * healthy). The second is the dangerous one, and the module's own comment flags
 * a case where it can happen — pinned below.
 */

const project = (sourceRef: string) =>
  ({ id: 'p-1', sourceRef }) as unknown as ProjectRow;

describe('LocalPathAdapter', () => {
  const adapter = new LocalPathAdapter();
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'qa-local-path-'));
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a.ts'), 'const a = 1;');
    await writeFile(path.join(root, 'README.md'), '# hi');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const revisionOf = async () =>
    (await adapter.materialize(project(root))).revision;

  describe('TC-LPA-001..004 — materialize contract', () => {
    it('TC-LPA-001 returns the source path as the workspace path', async () => {
      const result = await adapter.materialize(project(root));
      expect(result.workspacePath).toBe(root);
    });

    it('TC-LPA-002 returns a sha256-shaped revision', async () => {
      expect(await revisionOf()).toMatch(/^[0-9a-f]{64}$/);
    });

    it('TC-LPA-003 throws NotFound for a path that does not exist', async () => {
      await expect(
        adapter.materialize(project(path.join(root, 'nope'))),
      ).rejects.toThrow(NotFoundException);
    });

    it('TC-LPA-004 never deletes the user’s own folder on cleanup', async () => {
      // The workspace IS the user's directory — cleanup must be a no-op.
      await adapter.cleanup();
      await expect(stat(root)).resolves.toBeDefined();
      await expect(stat(path.join(root, 'src', 'a.ts'))).resolves.toBeDefined();
    });
  });

  describe('TC-LPA-010..016 — revision stability', () => {
    it('TC-LPA-010 is stable across repeated calls with no changes', async () => {
      expect(await revisionOf()).toBe(await revisionOf());
    });

    it('TC-LPA-011 changes when a file’s content length changes', async () => {
      const before = await revisionOf();
      await writeFile(path.join(root, 'src', 'a.ts'), 'const a = 1; // longer');
      expect(await revisionOf()).not.toBe(before);
    });

    it('TC-LPA-012 changes when a file is added', async () => {
      const before = await revisionOf();
      await writeFile(path.join(root, 'src', 'b.ts'), 'const b = 2;');
      expect(await revisionOf()).not.toBe(before);
    });

    it('TC-LPA-013 changes when a file is removed', async () => {
      const before = await revisionOf();
      await rm(path.join(root, 'README.md'));
      expect(await revisionOf()).not.toBe(before);
    });

    it('TC-LPA-014 changes when a file is renamed', async () => {
      const before = await revisionOf();
      await writeFile(path.join(root, 'src', 'renamed.ts'), 'const a = 1;');
      await rm(path.join(root, 'src', 'a.ts'));
      expect(await revisionOf()).not.toBe(before);
    });

    it('TC-LPA-015 changes when only the mtime moves', async () => {
      const before = await revisionOf();
      const future = new Date(Date.now() + 60_000);
      await utimes(path.join(root, 'src', 'a.ts'), future, future);
      expect(await revisionOf()).not.toBe(before);
    });

    it('TC-LPA-016 is independent of filesystem enumeration order', async () => {
      // Entries are sorted before hashing, so the revision cannot depend on the
      // order fast-glob happens to return.
      const first = await revisionOf();
      for (let i = 0; i < 5; i++) {
        await writeFile(path.join(root, `z${i}.txt`), 'x');
      }
      const withExtras = await revisionOf();
      for (let i = 0; i < 5; i++) await rm(path.join(root, `z${i}.txt`));
      expect(await revisionOf()).toBe(first);
      expect(withExtras).not.toBe(first);
    });
  });

  describe('TC-LPA-020..022 — ignored directories', () => {
    it('TC-LPA-020 ignores node_modules, .git, dist and build', async () => {
      const before = await revisionOf();
      for (const dir of ['node_modules', '.git', 'dist', 'build']) {
        await mkdir(path.join(root, dir), { recursive: true });
        await writeFile(path.join(root, dir, 'noise.js'), 'lots of churn');
      }
      expect(await revisionOf()).toBe(before);
    });

    it('TC-LPA-021 ignores those directories at any depth', async () => {
      const before = await revisionOf();
      const nested = path.join(root, 'packages', 'app', 'node_modules', 'dep');
      await mkdir(nested, { recursive: true });
      await writeFile(path.join(nested, 'index.js'), 'x');
      expect(await revisionOf()).toBe(before);
    });

    it('TC-LPA-022 includes dotfiles that are not in the ignore list', async () => {
      const before = await revisionOf();
      await writeFile(path.join(root, '.env.example'), 'KEY=');
      expect(await revisionOf()).not.toBe(before);
    });

    it('TC-LPA-023 exports the ignore list it actually uses', () => {
      expect(REVISION_IGNORE_GLOBS).toEqual([
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
      ]);
    });
  });

  it('TC-LPA-030 [DEFECT-008] misses a same-size edit that preserves the mtime', async () => {
    // The hash is (relPath, size, mtime) — not content. A tool that rewrites a
    // file to the same length while restoring its timestamp (zip extraction,
    // rsync --archive, some restore flows) produces an IDENTICAL revision, so
    // indexing early-exits and the index silently goes stale.
    //
    // The module's own comment acknowledges this trade-off. Pinned here so the
    // exposure is measured rather than assumed, and logged as DEF-008.
    const file = path.join(root, 'src', 'a.ts');
    const original = await stat(file);
    const before = await revisionOf();

    await writeFile(file, 'const a = 2;'); // same byte length, different content
    await utimes(file, original.atime, original.mtime); // restore the timestamp

    expect(await revisionOf()).toBe(before);
  });

  it('TC-LPA-031 returns a stable revision for an empty directory', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'qa-empty-'));
    try {
      const a = await adapter.materialize(project(empty));
      const b = await adapter.materialize(project(empty));
      expect(a.revision).toBe(b.revision);
      expect(a.revision).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
