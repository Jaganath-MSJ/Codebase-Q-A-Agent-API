import { describe, it, expect } from 'vitest';
import {
  findReferencesTool,
  FIND_REFERENCES_TOOL,
} from './find-references.tool';
import type { RetrievalService } from '../../retrieval/retrieval.service';

/** QA pass — TC-TOOL-3xx. */

const PROJECT_ID = 'p-1';

function fakeRetrieval(results: unknown[] = []) {
  const calls: { projectId: string; symbol: string }[] = [];
  const service = {
    findReferences: (projectId: string, symbol: string) => {
      calls.push({ projectId, symbol });
      return Promise.resolve(results);
    },
  } as unknown as RetrievalService;
  return { service, calls };
}

describe('FIND_REFERENCES_TOOL definition', () => {
  it('TC-TOOL-300 requires a symbol argument', () => {
    expect(FIND_REFERENCES_TOOL.name).toBe('find_references');
    expect(FIND_REFERENCES_TOOL.parameters.required).toEqual(['symbol']);
  });
});

describe('findReferencesTool', () => {
  describe('TC-TOOL-310..313 — argument validation', () => {
    it('TC-TOOL-310 rejects a missing symbol', async () => {
      const { service } = fakeRetrieval();
      expect((await findReferencesTool(service, PROJECT_ID, {})).note).toMatch(
        /requires a non-empty "symbol"/,
      );
    });

    it('TC-TOOL-311 rejects empty and whitespace-only symbols', async () => {
      const { service, calls } = fakeRetrieval();
      for (const symbol of ['', '  ', '\t']) {
        expect(
          (await findReferencesTool(service, PROJECT_ID, { symbol })).note,
        ).toMatch(/non-empty "symbol"/);
      }
      expect(calls).toHaveLength(0);
    });

    it('TC-TOOL-312 rejects a non-string symbol', async () => {
      const { service } = fakeRetrieval();
      expect(
        (await findReferencesTool(service, PROJECT_ID, { symbol: 12 })).note,
      ).toMatch(/non-empty "symbol"/);
    });

    it('TC-TOOL-313 trims the symbol before searching', async () => {
      const { service, calls } = fakeRetrieval([]);
      await findReferencesTool(service, PROJECT_ID, { symbol: '  foo  ' });
      expect(calls[0]!.symbol).toBe('foo');
    });
  });

  describe('TC-TOOL-320..327 — grouping and output', () => {
    it('TC-TOOL-320 reports no references, naming the symbol', async () => {
      const { service } = fakeRetrieval([]);
      const result = await findReferencesTool(service, PROJECT_ID, {
        symbol: 'missingFn',
      });
      expect(result.regions).toEqual([]);
      expect(result.note).toBe('No references to "missingFn" found.');
    });

    it('TC-TOOL-321 groups multiple ranges under one file', async () => {
      const { service } = fakeRetrieval([
        { path: 'src/a.ts', startLine: 1, endLine: 3 },
        { path: 'src/a.ts', startLine: 10, endLine: 12 },
      ]);
      const result = await findReferencesTool(service, PROJECT_ID, {
        symbol: 'foo',
      });
      expect(result.note).toBe('src/a.ts: 1-3, 10-12');
    });

    it('TC-TOOL-322 puts each file on its own line', async () => {
      const { service } = fakeRetrieval([
        { path: 'src/a.ts', startLine: 1, endLine: 3 },
        { path: 'src/b.ts', startLine: 7, endLine: 7 },
      ]);
      const note = (
        await findReferencesTool(service, PROJECT_ID, { symbol: 'foo' })
      ).note!;
      expect(note.split('\n')).toEqual(['src/a.ts: 1-3', 'src/b.ts: 7-7']);
    });

    it('TC-TOOL-323 preserves first-seen file order', async () => {
      const { service } = fakeRetrieval([
        { path: 'src/z.ts', startLine: 1, endLine: 1 },
        { path: 'src/a.ts', startLine: 2, endLine: 2 },
        { path: 'src/z.ts', startLine: 3, endLine: 3 },
      ]);
      const note = (
        await findReferencesTool(service, PROJECT_ID, { symbol: 'foo' })
      ).note!;
      expect(note.split('\n')[0]).toBe('src/z.ts: 1-1, 3-3');
      expect(note.split('\n')[1]).toBe('src/a.ts: 2-2');
    });

    it('TC-TOOL-324 never populates regions — locations only, by design', async () => {
      const { service } = fakeRetrieval([
        { path: 'src/a.ts', startLine: 1, endLine: 3, content: 'code here' },
      ]);
      const result = await findReferencesTool(service, PROJECT_ID, {
        symbol: 'foo',
      });
      expect(result.regions).toEqual([]);
      expect(result.note).not.toContain('code here');
    });

    it('TC-TOOL-325 handles a single-line reference', async () => {
      const { service } = fakeRetrieval([
        { path: 'src/a.ts', startLine: 42, endLine: 42 },
      ]);
      expect(
        (await findReferencesTool(service, PROJECT_ID, { symbol: 'foo' })).note,
      ).toBe('src/a.ts: 42-42');
    });

    it('TC-TOOL-326 emits only repo-relative forward-slash paths (INV-2)', async () => {
      const { service } = fakeRetrieval([
        { path: 'src/nested/deep/a.ts', startLine: 1, endLine: 1 },
      ]);
      const note = (
        await findReferencesTool(service, PROJECT_ID, { symbol: 'foo' })
      ).note!;
      expect(note).not.toContain('\\');
      expect(note.startsWith('/')).toBe(false);
    });

    it('TC-TOOL-327 handles many files without truncating', async () => {
      const many = Array.from({ length: 100 }, (_, i) => ({
        path: `src/f${i}.ts`,
        startLine: 1,
        endLine: 1,
      }));
      const { service } = fakeRetrieval(many);
      const note = (
        await findReferencesTool(service, PROJECT_ID, { symbol: 'foo' })
      ).note!;
      expect(note.split('\n')).toHaveLength(100);
    });
  });

  it('TC-TOOL-330 passes a symbol containing regex metacharacters through untouched', async () => {
    const { service, calls } = fakeRetrieval([]);
    await findReferencesTool(service, PROJECT_ID, { symbol: 'foo.*bar[0]' });
    expect(calls[0]!.symbol).toBe('foo.*bar[0]');
  });
});
