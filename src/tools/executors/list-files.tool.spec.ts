import { describe, it, expect } from 'vitest';
import { listFilesTool, LIST_FILES_TOOL } from './list-files.tool';
import type { FilesRepository } from '../../db/repositories/files.repository';

/** QA pass — TC-TOOL-1xx. */

const PROJECT_ID = 'p-1';

function fakeFilesRepo(paths: string[]): FilesRepository {
  return {
    findAllByProjectId: () => Promise.resolve(paths.map((path) => ({ path }))),
  } as unknown as FilesRepository;
}

const REPO = [
  'src/index.ts',
  'src/auth.service.ts',
  'src/auth.controller.ts',
  'src/nested/deep/file.ts',
  'src/nested/util.ts',
  'README.md',
  'package.json',
];

describe('LIST_FILES_TOOL definition', () => {
  it('TC-TOOL-100 requires a glob argument', () => {
    expect(LIST_FILES_TOOL.name).toBe('list_files');
    expect(LIST_FILES_TOOL.parameters.required).toEqual(['glob']);
  });
});

describe('listFilesTool', () => {
  const call = (args: Record<string, unknown>, paths = REPO) =>
    listFilesTool(fakeFilesRepo(paths), PROJECT_ID, args);

  describe('TC-TOOL-110..115 — argument validation', () => {
    it('TC-TOOL-110 rejects a missing glob', async () => {
      expect((await call({})).note).toMatch(/requires a non-empty "glob"/);
    });

    it('TC-TOOL-111 rejects an empty glob', async () => {
      expect((await call({ glob: '' })).note).toMatch(/non-empty "glob"/);
    });

    it('TC-TOOL-112 rejects a whitespace-only glob', async () => {
      expect((await call({ glob: '   ' })).note).toMatch(/non-empty "glob"/);
    });

    it('TC-TOOL-113 rejects a non-string glob', async () => {
      expect((await call({ glob: 7 })).note).toMatch(/non-empty "glob"/);
    });

    it('TC-TOOL-114 accepts a glob at exactly the 256-character cap', async () => {
      const glob = '*'.repeat(256);
      expect((await call({ glob })).note).not.toMatch(/too long/);
    });

    it('TC-TOOL-115 rejects a glob over the 256-character cap (SEC)', async () => {
      const result = await call({ glob: '*'.repeat(257) });
      expect(result.regions).toEqual([]);
      expect(result.note).toMatch(/too long \(max 256 characters\)/);
    });
  });

  describe('TC-TOOL-120..126 — matching', () => {
    it('TC-TOOL-120 matches a single-segment star', async () => {
      const note = (await call({ glob: 'src/*.ts' })).note!;
      expect(note.split('\n')).toEqual([
        'src/auth.controller.ts',
        'src/auth.service.ts',
        'src/index.ts',
      ]);
    });

    it('TC-TOOL-121 matches a globstar across segments', async () => {
      const note = (await call({ glob: 'src/**/*.ts' })).note!;
      expect(note).toContain('src/nested/deep/file.ts');
      expect(note).toContain('src/index.ts');
    });

    it('TC-TOOL-122 returns results sorted, so output is deterministic', async () => {
      const shuffled = [...REPO].reverse();
      const note = (await call({ glob: '**/*.ts' }, shuffled)).note!;
      const lines = note.split('\n');
      expect([...lines].sort()).toEqual(lines);
    });

    it('TC-TOOL-123 reports no matches distinctly from an error', async () => {
      const result = await call({ glob: '**/*.rs' });
      expect(result.regions).toEqual([]);
      expect(result.note).toBe('No files matched.');
    });

    it('TC-TOOL-124 returns an empty listing for a project with no files', async () => {
      expect((await call({ glob: '**/*' }, [])).note).toBe('No files matched.');
    });

    it('TC-TOOL-125 never populates regions — listings are note-only', async () => {
      expect((await call({ glob: '**/*.ts' })).regions).toEqual([]);
    });

    it('TC-TOOL-126 trims surrounding whitespace from the glob', async () => {
      expect((await call({ glob: '  src/*.ts  ' })).note).toContain(
        'src/index.ts',
      );
    });
  });

  describe('TC-TOOL-130..132 — truncation at 200 results', () => {
    const many = Array.from(
      { length: 250 },
      (_, i) => `src/f${String(i).padStart(3, '0')}.ts`,
    );

    it('TC-TOOL-130 shows at most 200 paths', async () => {
      const note = (await call({ glob: '**/*.ts' }, many)).note!;
      const paths = note.split('\n').filter((l) => l.endsWith('.ts'));
      expect(paths).toHaveLength(200);
    });

    it('TC-TOOL-131 states how many were withheld', async () => {
      const note = (await call({ glob: '**/*.ts' }, many)).note!;
      expect(note).toContain('... [50 more, truncated]');
    });

    it('TC-TOOL-132 adds no truncation notice at exactly 200', async () => {
      const exactly = many.slice(0, 200);
      const note = (await call({ glob: '**/*.ts' }, exactly)).note!;
      expect(note).not.toContain('truncated');
    });
  });

  it('TC-TOOL-140 stays fast on a pathological glob within the cap (SEC)', async () => {
    const many = Array.from(
      { length: 500 },
      (_, i) => `src/${'a'.repeat(40)}${i}.ts`,
    );
    const start = performance.now();
    await call({ glob: '*a'.repeat(120) + '!' }, many);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
