import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileTool, READ_FILE_TOOL } from './read-file.tool';
import type { ProjectsRepository } from '../../db/repositories/projects.repository';

/**
 * QA pass — TC-TOOL-0xx.
 *
 * `read_file`'s arguments come from the LLM, so its validation and containment
 * paths are security surface rather than defensive politeness: a model asked to
 * investigate a bug will cheerfully try `../../.env`, and that isn't malice.
 */

const PROJECT_ID = 'p-1';

/** Minimal stand-in — the tool only ever calls `findById`. */
function fakeProjectsRepo(project: unknown): ProjectsRepository {
  return {
    findById: (id: string) =>
      Promise.resolve(id === PROJECT_ID ? project : null),
  } as unknown as ProjectsRepository;
}

describe('READ_FILE_TOOL definition', () => {
  it('TC-TOOL-001 declares path as the only required argument', () => {
    expect(READ_FILE_TOOL.name).toBe('read_file');
    expect(READ_FILE_TOOL.parameters.required).toEqual(['path']);
    expect(Object.keys(READ_FILE_TOOL.parameters.properties)).toEqual([
      'path',
      'startLine',
      'endLine',
    ]);
  });
});

describe('readFileTool', () => {
  let workspace: string;
  let repo: ProjectsRepository;

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'qa-read-tool-'));
    await mkdir(path.join(workspace, 'src'), { recursive: true });
    await writeFile(
      path.join(workspace, 'src', 'index.ts'),
      Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n'),
    );
    await writeFile(path.join(workspace, 'src', 'tiny.ts'), 'only line');
    await writeFile(path.join(workspace, 'src', 'empty.ts'), '');
    await writeFile(path.join(workspace, 'src', 'crlf.ts'), 'a\r\nb\r\nc');
    // A file the tool must never be able to reach from inside the workspace.
    await writeFile(
      path.join(workspace, '..', 'qa-outside-secret.txt'),
      'nope',
    );

    repo = fakeProjectsRepo({ workspacePath: workspace, sourceRef: workspace });
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(path.join(workspace, '..', 'qa-outside-secret.txt'), {
      force: true,
    });
  });

  const call = (args: Record<string, unknown>) =>
    readFileTool(repo, PROJECT_ID, args);

  describe('TC-TOOL-010..015 — argument validation', () => {
    it('TC-TOOL-010 rejects a missing path', async () => {
      const result = await call({});
      expect(result.regions).toEqual([]);
      expect(result.note).toMatch(/requires a non-empty "path"/);
    });

    it('TC-TOOL-011 rejects an empty path', async () => {
      expect((await call({ path: '' })).note).toMatch(/non-empty "path"/);
    });

    it('TC-TOOL-012 rejects a whitespace-only path', async () => {
      expect((await call({ path: '   ' })).note).toMatch(/non-empty "path"/);
    });

    it('TC-TOOL-013 rejects a non-string path', async () => {
      expect((await call({ path: 42 })).note).toMatch(/non-empty "path"/);
      expect((await call({ path: null })).note).toMatch(/non-empty "path"/);
      expect((await call({ path: ['a'] })).note).toMatch(/non-empty "path"/);
    });

    it('TC-TOOL-014 trims surrounding whitespace from the path', async () => {
      const result = await call({ path: '  src/tiny.ts  ' });
      expect(result.regions).toHaveLength(1);
      expect(result.regions[0]!.content).toBe('only line');
    });

    it('TC-TOOL-015 reports an unknown project rather than throwing', async () => {
      const result = await readFileTool(repo, 'does-not-exist', {
        path: 'src/tiny.ts',
      });
      expect(result.regions).toEqual([]);
      expect(result.note).toMatch(/project does-not-exist not found/);
    });
  });

  describe('TC-TOOL-020..026 — containment (SEC)', () => {
    const escapes = [
      ['TC-TOOL-020', '../qa-outside-secret.txt'],
      ['TC-TOOL-021', '../../etc/passwd'],
      ['TC-TOOL-022', '/etc/passwd'],
      ['TC-TOOL-023', '..\\..\\etc\\passwd'],
      ['TC-TOOL-024', 'C:/Windows/win.ini'],
      ['TC-TOOL-025', 'src/../../qa-outside-secret.txt'],
      ['TC-TOOL-026', '\\\\server\\share\\x'],
    ] as const;

    for (const [id, candidate] of escapes) {
      it(`${id} refuses ${JSON.stringify(candidate)}`, async () => {
        const result = await call({ path: candidate });
        expect(result.regions).toEqual([]);
        expect(result.note).toMatch(/escapes the project workspace/);
        // The refusal must not leak the absolute host path it resolved to.
        expect(result.note).not.toContain(workspace);
      });
    }
  });

  describe('TC-TOOL-030..033 — missing files', () => {
    it('TC-TOOL-030 reports a missing file as a note, not an exception', async () => {
      const result = await call({ path: 'src/nope.ts' });
      expect(result.regions).toEqual([]);
      expect(result.note).toBe('Error: file not found: src/nope.ts');
    });

    it('TC-TOOL-031 reports a missing nested directory as not found', async () => {
      expect((await call({ path: 'no/such/dir/file.ts' })).note).toMatch(
        /file not found/,
      );
    });

    it('TC-TOOL-032 returns no region for an empty file', async () => {
      // An empty file has zero lines, so startLine 1 is already past the end.
      const result = await call({ path: 'src/empty.ts' });
      expect(result.regions).toEqual([]);
      expect(result.note).toMatch(/past the end of the file \(0 lines\)/);
    });

    it('TC-TOOL-033 [DEFECT-004 fixed] answers a directory read with a note, not an exception', async () => {
      // Was the S2 leak: EISDIR propagated, the registry turned `err.message`
      // into the model-visible note, and that message embeds the absolute
      // workspace path. Now handled here, in the model's own vocabulary.
      const result = await call({ path: 'src' });

      expect(result.regions).toEqual([]);
      expect(result.note).toBe(
        'Error: "src" is a directory, not a file. Use list_files to see what is inside it.',
      );
      expect(result.note).not.toContain(workspace);
    });

    it('TC-TOOL-034 [DEFECT-004 fixed] reports any other fs error by code, without the absolute path', async () => {
      // EISDIR is the reachable one; the guarantee worth pinning is that NO fs
      // error escapes as a raw driver message. Provoked for real rather than
      // stubbed: a 300-character filename exceeds NAME_MAX (255), so the read
      // fails with ENAMETOOLONG — a genuine non-ENOENT, non-EISDIR error.
      const relPath = `src/${'n'.repeat(300)}.ts`;
      const result = await call({ path: relPath });

      expect(result.regions).toEqual([]);
      // The code differs by platform, so pin the shape and the repo-relative
      // path rather than one errno spelling.
      expect(result.note).toMatch(
        new RegExp(`^Error: could not read ${relPath} \\([A-Z]+\\)\\.$`),
      );
      expect(result.note).not.toContain(workspace);
    });
  });

  describe('TC-TOOL-040..049 — line ranges', () => {
    it('TC-TOOL-040 returns the default 300-line window when no range is given', async () => {
      const result = await call({ path: 'src/index.ts' });
      expect(result.regions).toHaveLength(1);
      expect(result.regions[0]!.startLine).toBe(1);
      expect(result.regions[0]!.endLine).toBe(300);
    });

    it('TC-TOOL-041 honours an explicit inclusive range', async () => {
      const [region] = (
        await call({ path: 'src/index.ts', startLine: 10, endLine: 12 })
      ).regions;
      expect(region!.startLine).toBe(10);
      expect(region!.endLine).toBe(12);
      expect(region!.content).toBe('line 10\nline 11\nline 12');
    });

    it('TC-TOOL-042 clamps endLine to the end of the file', async () => {
      const [region] = (
        await call({ path: 'src/index.ts', startLine: 498, endLine: 9999 })
      ).regions;
      expect(region!.endLine).toBe(500);
      expect(region!.content).toBe('line 498\nline 499\nline 500');
    });

    it('TC-TOOL-043 clamps startLine up to 1 for zero and negatives', async () => {
      for (const startLine of [0, -5]) {
        const [region] = (await call({ path: 'src/tiny.ts', startLine }))
          .regions;
        expect(region!.startLine).toBe(1);
      }
    });

    it('TC-TOOL-044 floors a fractional startLine and endLine', async () => {
      const [region] = (
        await call({ path: 'src/index.ts', startLine: 2.9, endLine: 4.9 })
      ).regions;
      expect(region!.startLine).toBe(2);
      expect(region!.endLine).toBe(4);
    });

    it('TC-TOOL-045 errors when startLine is past the end of the file', async () => {
      const result = await call({ path: 'src/tiny.ts', startLine: 2 });
      expect(result.regions).toEqual([]);
      expect(result.note).toMatch(
        /startLine 2 is past the end of the file \(1 lines\)/,
      );
    });

    it('TC-TOOL-046 reads exactly the last line', async () => {
      const [region] = (
        await call({ path: 'src/index.ts', startLine: 500, endLine: 500 })
      ).regions;
      expect(region!.content).toBe('line 500');
    });

    it('TC-TOOL-047 returns an empty content string when endLine precedes startLine', async () => {
      // slice(start-1, end) with end < start yields []; join gives ''. Documented
      // rather than corrected — this phase changes no product code.
      const [region] = (
        await call({ path: 'src/index.ts', startLine: 10, endLine: 5 })
      ).regions;
      expect(region!.content).toBe('');
      expect(region!.endLine).toBe(5);
      expect(region!.startLine).toBe(10);
    });

    it('TC-TOOL-048 ignores a non-numeric startLine and falls back to 1', async () => {
      const [region] = (await call({ path: 'src/tiny.ts', startLine: '5' }))
        .regions;
      expect(region!.startLine).toBe(1);
    });

    it('TC-TOOL-049 derives lines through read-file.ts, so CRLF is normalised (INV-3)', async () => {
      const [region] = (await call({ path: 'src/crlf.ts' })).regions;
      expect(region!.content).toBe('a\nb\nc');
      expect(region!.content).not.toContain('\r');
      expect(region!.endLine).toBe(3);
    });
  });

  describe('TC-TOOL-050..051 — returned region shape', () => {
    it('TC-TOOL-050 echoes the repo-relative path, never the absolute one (INV-2)', async () => {
      const [region] = (await call({ path: 'src/tiny.ts' })).regions;
      expect(region!.path).toBe('src/tiny.ts');
      expect(region!.path).not.toContain(workspace);
      expect(path.isAbsolute(region!.path)).toBe(false);
    });

    it('TC-TOOL-051 satisfies the INV-9 reconstruction property', async () => {
      const [region] = (
        await call({ path: 'src/index.ts', startLine: 7, endLine: 11 })
      ).regions;
      expect(region!.content.split('\n')).toHaveLength(
        region!.endLine - region!.startLine + 1,
      );
    });
  });

  it('TC-TOOL-060 falls back to sourceRef when workspacePath is absent', async () => {
    const fallbackRepo = fakeProjectsRepo({
      workspacePath: null,
      sourceRef: workspace,
    });
    const result = await readFileTool(fallbackRepo, PROJECT_ID, {
      path: 'src/tiny.ts',
    });
    expect(result.regions[0]!.content).toBe('only line');
  });
});
