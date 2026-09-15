import { describe, it, expect } from 'vitest';
import { searchCodeTool, SEARCH_CODE_TOOL } from './search-code.tool';
import type { RetrievalService } from '../../retrieval/retrieval.service';

/** QA pass — TC-TOOL-2xx. */

const PROJECT_ID = 'p-1';

interface Recorded {
  projectId: string;
  query: string;
  mode: string;
  limit: number;
}

function fakeRetrieval(results: unknown[] = []) {
  const calls: Recorded[] = [];
  const service = {
    search: (projectId: string, query: string, mode: string, limit: number) => {
      calls.push({ projectId, query, mode, limit });
      return Promise.resolve(results);
    },
  } as unknown as RetrievalService;
  return { service, calls };
}

const HIT = {
  path: 'src/auth.service.ts',
  startLine: 10,
  endLine: 20,
  content: 'function validateUser() {}',
  score: 0.9,
  extra: 'should not be forwarded',
};

describe('SEARCH_CODE_TOOL definition', () => {
  it('TC-TOOL-200 requires query and offers hybrid/exact modes', () => {
    expect(SEARCH_CODE_TOOL.name).toBe('search_code');
    expect(SEARCH_CODE_TOOL.parameters.required).toEqual(['query']);
    // `properties` is loosely typed in the ToolDefinition contract (it mirrors
    // a JSON Schema), so narrow it here rather than reaching through `any`.
    const mode = (
      SEARCH_CODE_TOOL.parameters.properties as Record<
        string,
        { enum?: string[] }
      >
    ).mode;
    expect(mode?.enum).toEqual(['hybrid', 'exact']);
  });
});

describe('searchCodeTool', () => {
  describe('TC-TOOL-210..213 — argument validation', () => {
    it('TC-TOOL-210 rejects a missing query', async () => {
      const { service } = fakeRetrieval();
      expect((await searchCodeTool(service, PROJECT_ID, {})).note).toMatch(
        /requires a non-empty "query"/,
      );
    });

    it('TC-TOOL-211 rejects an empty or whitespace-only query', async () => {
      const { service, calls } = fakeRetrieval();
      for (const query of ['', '   ', '\n\t']) {
        expect(
          (await searchCodeTool(service, PROJECT_ID, { query })).note,
        ).toMatch(/non-empty "query"/);
      }
      expect(calls).toHaveLength(0); // never reaches the retriever
    });

    it('TC-TOOL-212 rejects a non-string query', async () => {
      const { service } = fakeRetrieval();
      expect(
        (await searchCodeTool(service, PROJECT_ID, { query: 5 })).note,
      ).toMatch(/non-empty "query"/);
    });

    it('TC-TOOL-213 trims the query before searching', async () => {
      const { service, calls } = fakeRetrieval([HIT]);
      await searchCodeTool(service, PROJECT_ID, { query: '  auth  ' });
      expect(calls[0]!.query).toBe('auth');
    });
  });

  describe('TC-TOOL-220..224 — mode selection', () => {
    it('TC-TOOL-220 defaults to hybrid', async () => {
      const { service, calls } = fakeRetrieval([HIT]);
      await searchCodeTool(service, PROJECT_ID, { query: 'x' });
      expect(calls[0]!.mode).toBe('hybrid');
    });

    it('TC-TOOL-221 maps "exact" to the fts retriever', async () => {
      const { service, calls } = fakeRetrieval([HIT]);
      await searchCodeTool(service, PROJECT_ID, { query: 'x', mode: 'exact' });
      expect(calls[0]!.mode).toBe('fts');
    });

    it('TC-TOOL-222 falls back to hybrid for an unrecognised mode', async () => {
      const { service, calls } = fakeRetrieval([HIT]);
      await searchCodeTool(service, PROJECT_ID, { query: 'x', mode: 'fuzzy' });
      expect(calls[0]!.mode).toBe('hybrid');
    });

    it('TC-TOOL-223 falls back to hybrid for a non-string mode', async () => {
      const { service, calls } = fakeRetrieval([HIT]);
      await searchCodeTool(service, PROJECT_ID, { query: 'x', mode: 1 });
      expect(calls[0]!.mode).toBe('hybrid');
    });

    it('TC-TOOL-224 is case sensitive about "exact"', async () => {
      const { service, calls } = fakeRetrieval([HIT]);
      await searchCodeTool(service, PROJECT_ID, { query: 'x', mode: 'EXACT' });
      expect(calls[0]!.mode).toBe('hybrid');
    });
  });

  describe('TC-TOOL-230..236 — limit boundaries', () => {
    const limitFor = async (limit: unknown) => {
      const { service, calls } = fakeRetrieval([HIT]);
      await searchCodeTool(service, PROJECT_ID, { query: 'x', limit });
      return calls[0]!.limit;
    };

    it('TC-TOOL-230 defaults to 10', async () => {
      expect(await limitFor(undefined)).toBe(10);
    });

    it('TC-TOOL-231 caps at 20', async () => {
      expect(await limitFor(9999)).toBe(20);
      expect(await limitFor(21)).toBe(20);
    });

    it('TC-TOOL-232 accepts exactly 20', async () => {
      expect(await limitFor(20)).toBe(20);
    });

    it('TC-TOOL-233 accepts 1', async () => {
      expect(await limitFor(1)).toBe(1);
    });

    it('TC-TOOL-234 falls back to 10 for zero and negatives', async () => {
      expect(await limitFor(0)).toBe(10);
      expect(await limitFor(-5)).toBe(10);
    });

    it('TC-TOOL-235 floors a fractional limit', async () => {
      expect(await limitFor(3.9)).toBe(3);
    });

    it('TC-TOOL-236 falls back to 10 for a non-numeric limit', async () => {
      expect(await limitFor('5')).toBe(10);
      expect(await limitFor(null)).toBe(10);
    });
  });

  describe('TC-TOOL-240..243 — results', () => {
    it('TC-TOOL-240 reports no results distinctly', async () => {
      const { service } = fakeRetrieval([]);
      const result = await searchCodeTool(service, PROJECT_ID, { query: 'x' });
      expect(result.regions).toEqual([]);
      expect(result.note).toBe('No results.');
    });

    it('TC-TOOL-241 maps hits to evidence regions', async () => {
      const { service } = fakeRetrieval([HIT]);
      const result = await searchCodeTool(service, PROJECT_ID, { query: 'x' });
      expect(result.regions).toEqual([
        {
          path: 'src/auth.service.ts',
          startLine: 10,
          endLine: 20,
          content: 'function validateUser() {}',
        },
      ]);
    });

    it('TC-TOOL-242 forwards only the four evidence fields', async () => {
      // Extra retriever fields (score, internal ids) must not leak into the
      // ledger — the region shape is the contract the citation layer relies on.
      const { service } = fakeRetrieval([HIT]);
      const [region] = (
        await searchCodeTool(service, PROJECT_ID, { query: 'x' })
      ).regions;
      expect(Object.keys(region!).sort()).toEqual([
        'content',
        'endLine',
        'path',
        'startLine',
      ]);
    });

    it('TC-TOOL-243 preserves retriever ordering', async () => {
      const second = { ...HIT, path: 'src/b.ts' };
      const { service } = fakeRetrieval([HIT, second]);
      const result = await searchCodeTool(service, PROJECT_ID, { query: 'x' });
      expect(result.regions.map((r) => r.path)).toEqual([
        'src/auth.service.ts',
        'src/b.ts',
      ]);
    });
  });

  it('TC-TOOL-250 passes a metacharacter-laden query through untouched', async () => {
    // Escaping is the retriever's job; the tool must not mangle the query.
    const { service, calls } = fakeRetrieval([HIT]);
    const query = "'; DROP TABLE chunks; -- .*+?[]{}()";
    await searchCodeTool(service, PROJECT_ID, { query });
    expect(calls[0]!.query).toBe(query);
  });

  it('TC-TOOL-251 handles a 10,000-character query', async () => {
    const { service, calls } = fakeRetrieval([]);
    await searchCodeTool(service, PROJECT_ID, { query: 'x'.repeat(10_000) });
    expect(calls[0]!.query).toHaveLength(10_000);
  });
});
