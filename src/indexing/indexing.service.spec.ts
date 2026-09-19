import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConsoleLogger, Logger, NotFoundException } from '@nestjs/common';
import { IndexingService, IndexCanceledError } from './indexing.service';
import type { IndexProgress } from './indexing.service';
import { CHUNKER_VERSION } from '../chunking/chunker.interface';
import { sha256 } from '../common/hash';

/**
 * QA pass — TC-IDX-*.
 *
 * `indexProject` is the pipeline everything else depends on. Its riskiest
 * behaviours are the ones that decide *not* to do work:
 *   - the revision early-exit (wrong → a stale index that looks healthy)
 *   - the per-file contentHash skip (wrong → edits never reach retrieval)
 *   - the 768-dimension guard (wrong → a corrupt vector column, INV-1)
 * All three are asserted here, along with cancellation and progress ordering.
 */

const PROJECT_ID = 'p-1';

interface WalkedEntry {
  relPath: string;
  absPath: string;
  text: string;
  lines: string[];
}

const entry = (relPath: string, text: string): WalkedEntry => ({
  relPath,
  absPath: `/ws/${relPath}`,
  text,
  lines: text.split('\n'),
});

function harness(
  options: {
    project?: Record<string, unknown> | null;
    revision?: string;
    walked?: WalkedEntry[];
    skipReasons?: Record<string, number>;
    existingFiles?: { id: string; path: string; contentHash: string }[];
    dimensions?: number;
    pendingChunks?: unknown[];
  } = {},
) {
  const {
    project = {
      id: PROJECT_ID,
      name: 'Proj',
      sourceKind: 'local_path',
      headRevision: null,
      sourceRef: '/ws',
    },
    revision = 'rev-new',
    walked = [],
    skipReasons = {},
    existingFiles = [],
    dimensions = 768,
    pendingChunks = [],
  } = options;

  const calls = {
    walks: 0,
    materialized: 0,
    replaced: [] as string[],
    deletedIds: [] as string[],
    chunked: [] as string[],
    updates: [] as Record<string, unknown>[],
    embedBatches: 0,
  };
  const progress: IndexProgress[] = [];

  let current = project ? { ...project } : null;

  const projectsRepository = {
    findById: () => Promise.resolve(current),
    update: (_id: string, patch: Record<string, unknown>) => {
      calls.updates.push(patch);
      current = current ? { ...current, ...patch } : null;
      return Promise.resolve(current);
    },
  };

  const filesRepository = {
    findAllByProjectId: () => Promise.resolve(existingFiles),
    deleteByIds: (ids: string[]) => {
      calls.deletedIds.push(...ids);
      return Promise.resolve();
    },
    replaceFile: (
      _p: string,
      _existingId: string | undefined,
      file: { path: string },
    ) => {
      calls.replaced.push(file.path);
      return Promise.resolve();
    },
  };

  const chunksRepository = {
    countByProjectId: () => Promise.resolve(walked.length),
    findWithoutEmbedding: () => Promise.resolve(pendingChunks),
    setEmbeddingsBulk: () => Promise.resolve(),
  };

  const walkerService = {
    walk: () => {
      calls.walks++;
      return Promise.resolve({ included: walked, skipReasons });
    },
  };

  const sourceAdapterRegistry = {
    getAdapter: () => ({
      materialize: () => {
        calls.materialized++;
        return Promise.resolve({ workspacePath: '/ws', revision });
      },
    }),
  };

  const repoOverviewService = {
    generate: () => Promise.resolve('an overview'),
  };
  const rateLimiter = { reserve: () => Promise.resolve() };

  const chunker = {
    chunk: (lines: string[]) => {
      calls.chunked.push(lines.join('\n'));
      return [
        {
          ord: 0,
          startLine: 1,
          endLine: lines.length,
          content: lines.join('\n'),
          symbol: null,
        },
      ];
    },
  };

  const embeddingProvider = {
    id: 'local:test-model',
    dimensions,
    maxBatchSize: 4,
    embedDocuments: (texts: string[]): Promise<number[][]> => {
      calls.embedBatches++;
      return Promise.resolve(texts.map(() => new Array<number>(768).fill(0.1)));
    },
  };

  const service = new IndexingService(
    projectsRepository as never,
    filesRepository as never,
    chunksRepository as never,
    {} as never,
    walkerService,
    sourceAdapterRegistry as never,
    repoOverviewService as never,
    rateLimiter as never,
    chunker as never,
    embeddingProvider as never,
  );

  const onProgress = (update: IndexProgress) => {
    progress.push(update);
  };

  return { service, calls, progress, onProgress };
}

describe('IndexingService.indexProject', () => {
  beforeEach(() => {
    // These tests drive failure paths deliberately; silence Nest's logger so a
    // passing run does not print a wall of scary-looking errors.
    Logger.overrideLogger(false);
  });

  afterEach(() => {
    Logger.overrideLogger(new ConsoleLogger());
  });

  describe('TC-IDX-001..003 — preconditions', () => {
    it('TC-IDX-001 throws NotFound for an unknown project', async () => {
      const { service } = harness({ project: null });
      await expect(service.indexProject(PROJECT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('TC-IDX-002 materialises the source before walking', async () => {
      const { service, calls } = harness({ walked: [entry('a.ts', 'x')] });
      await service.indexProject(PROJECT_ID);
      expect(calls.materialized).toBe(1);
      expect(calls.walks).toBe(1);
    });

    it('TC-IDX-003 persists the workspace path it resolved', async () => {
      const { service, calls } = harness();
      await service.indexProject(PROJECT_ID);
      expect(calls.updates[0]).toEqual({ workspacePath: '/ws' });
    });
  });

  describe('TC-IDX-010..014 — the revision early exit', () => {
    it('TC-IDX-010 skips the walk entirely when the revision is unchanged', async () => {
      const { service, calls } = harness({
        project: {
          id: PROJECT_ID,
          name: 'Proj',
          sourceKind: 'local_path',
          headRevision: 'rev-same',
        },
        revision: 'rev-same',
      });

      await service.indexProject(PROJECT_ID);

      expect(calls.walks).toBe(0);
      expect(calls.replaced).toEqual([]);
      expect(calls.embedBatches).toBe(0);
    });

    it('TC-IDX-011 still walks when the revision changed', async () => {
      const { service, calls } = harness({
        project: {
          id: PROJECT_ID,
          name: 'Proj',
          sourceKind: 'local_path',
          headRevision: 'rev-old',
        },
        revision: 'rev-new',
        walked: [entry('a.ts', 'x')],
      });

      await service.indexProject(PROJECT_ID);

      expect(calls.walks).toBe(1);
    });

    it('TC-IDX-012 never short-circuits a first index (headRevision null)', async () => {
      // The guard requires a non-null headRevision precisely so that a brand
      // new project cannot be skipped by a coincidental revision match.
      const { service, calls } = harness({
        project: {
          id: PROJECT_ID,
          name: 'Proj',
          sourceKind: 'local_path',
          headRevision: null,
        },
        revision: 'rev-new',
        walked: [entry('a.ts', 'x')],
      });

      await service.indexProject(PROJECT_ID);

      expect(calls.walks).toBe(1);
    });

    it('TC-IDX-013 force overrides the early exit', async () => {
      const { service, calls } = harness({
        project: {
          id: PROJECT_ID,
          name: 'Proj',
          sourceKind: 'local_path',
          headRevision: 'rev-same',
        },
        revision: 'rev-same',
        walked: [entry('a.ts', 'x')],
      });

      await service.indexProject(PROJECT_ID, undefined, undefined, true);

      expect(calls.walks).toBe(1);
      expect(calls.replaced).toEqual(['a.ts']);
    });

    it('TC-IDX-014 reports the finalizing phase even when it short-circuits', async () => {
      const { service, progress, onProgress } = harness({
        project: {
          id: PROJECT_ID,
          name: 'Proj',
          sourceKind: 'local_path',
          headRevision: 'rev-same',
        },
        revision: 'rev-same',
      });

      await service.indexProject(PROJECT_ID, onProgress);

      expect(progress.map((p) => p.phase)).toEqual(['walking', 'finalizing']);
    });
  });

  describe('TC-IDX-020..025 — per-file change detection', () => {
    const text = 'const a = 1;';
    const matchingHash = sha256(`${CHUNKER_VERSION}\n${text}`);

    it('TC-IDX-020 skips a file whose content hash is unchanged', async () => {
      const { service, calls } = harness({
        walked: [entry('a.ts', text)],
        existingFiles: [{ id: 'f-1', path: 'a.ts', contentHash: matchingHash }],
      });

      await service.indexProject(PROJECT_ID);

      expect(calls.chunked).toEqual([]);
      expect(calls.replaced).toEqual([]);
    });

    it('TC-IDX-021 counts an unchanged file under the "unchanged" skip reason', async () => {
      const { service, progress, onProgress } = harness({
        walked: [entry('a.ts', text)],
        existingFiles: [{ id: 'f-1', path: 'a.ts', contentHash: matchingHash }],
      });

      await service.indexProject(PROJECT_ID, onProgress);

      const chunking = progress.filter((p) => p.phase === 'chunking');
      expect(chunking.at(-1)!.skipReasons).toMatchObject({ unchanged: 1 });
    });

    it('TC-IDX-022 re-chunks a file whose content changed', async () => {
      const { service, calls } = harness({
        walked: [entry('a.ts', 'const a = 2;')],
        existingFiles: [{ id: 'f-1', path: 'a.ts', contentHash: matchingHash }],
      });

      await service.indexProject(PROJECT_ID);

      expect(calls.replaced).toEqual(['a.ts']);
    });

    it('TC-IDX-023 chunks a file that has no existing row', async () => {
      const { service, calls } = harness({ walked: [entry('new.ts', text)] });
      await service.indexProject(PROJECT_ID);
      expect(calls.replaced).toEqual(['new.ts']);
    });

    it('TC-IDX-024 bumping CHUNKER_VERSION invalidates an otherwise-unchanged file', async () => {
      // The version is folded into the hash so a chunker change forces exactly
      // one full re-chunk even though nothing on disk moved.
      const staleHash = sha256(`v-previous\n${text}`);
      const { service, calls } = harness({
        walked: [entry('a.ts', text)],
        existingFiles: [{ id: 'f-1', path: 'a.ts', contentHash: staleHash }],
      });

      await service.indexProject(PROJECT_ID);

      expect(calls.replaced).toEqual(['a.ts']);
    });

    it('TC-IDX-025 deletes rows for files that vanished from the tree', async () => {
      const { service, calls } = harness({
        walked: [entry('kept.ts', text)],
        existingFiles: [
          { id: 'f-kept', path: 'kept.ts', contentHash: 'x' },
          { id: 'f-gone', path: 'gone.ts', contentHash: 'y' },
        ],
      });

      await service.indexProject(PROJECT_ID);

      expect(calls.deletedIds).toEqual(['f-gone']);
    });
  });

  describe('TC-IDX-030..032 — cancellation', () => {
    it('TC-IDX-030 raises IndexCanceledError during chunking', async () => {
      const { service } = harness({
        walked: [entry('a.ts', 'x'), entry('b.ts', 'y')],
      });

      await expect(
        service.indexProject(PROJECT_ID, undefined, () =>
          Promise.resolve(true),
        ),
      ).rejects.toThrow(IndexCanceledError);
    });

    it('TC-IDX-031 names the file it was cancelled at', async () => {
      const { service } = harness({ walked: [entry('a.ts', 'x')] });

      await expect(
        service.indexProject(PROJECT_ID, undefined, () =>
          Promise.resolve(true),
        ),
      ).rejects.toThrow(/Canceled during chunking at a\.ts/);
    });

    it('TC-IDX-032 does no further work after cancelling', async () => {
      const { service, calls } = harness({
        walked: [entry('a.ts', 'x'), entry('b.ts', 'y'), entry('c.ts', 'z')],
      });

      await expect(
        service.indexProject(PROJECT_ID, undefined, () =>
          Promise.resolve(true),
        ),
      ).rejects.toThrow(IndexCanceledError);

      expect(calls.replaced).toEqual([]);
      expect(calls.embedBatches).toBe(0);
    });
  });

  describe('TC-IDX-040..042 — INV-1, the 768-dimension guard', () => {
    it('TC-IDX-040 refuses to embed when the provider reports the wrong dimension', async () => {
      const { service } = harness({
        walked: [entry('a.ts', 'x')],
        dimensions: 1536,
        pendingChunks: [{ id: 'c-1', content: 'x', startLine: 1, endLine: 1 }],
      });

      await expect(service.indexProject(PROJECT_ID)).rejects.toThrow(
        /reports 1536 dimensions; this project requires exactly 768/,
      );
    });

    it('TC-IDX-041 names the offending provider in the error', async () => {
      const { service } = harness({
        walked: [entry('a.ts', 'x')],
        dimensions: 512,
      });
      await expect(service.indexProject(PROJECT_ID)).rejects.toThrow(
        /local:test-model/,
      );
    });

    it('TC-IDX-042 checks the dimension even when there is nothing to embed', async () => {
      // The guard runs before the pending query, so a misconfigured provider
      // fails loudly rather than silently on the first repo that needs work.
      const { service } = harness({ walked: [], dimensions: 1024 });
      await expect(service.indexProject(PROJECT_ID)).rejects.toThrow(/1024/);
    });
  });

  describe('TC-IDX-050..053 — completion', () => {
    it('TC-IDX-050 records the new head revision', async () => {
      const { service, calls } = harness({
        revision: 'rev-final',
        walked: [entry('a.ts', 'x')],
      });

      await service.indexProject(PROJECT_ID);

      expect(calls.updates.at(-1)).toMatchObject({ headRevision: 'rev-final' });
    });

    it('TC-IDX-051 stamps the embedding model and dimension (INV-1)', async () => {
      // Retrieval refuses to run when the stored model does not match the
      // active provider, so this stamp is what makes that check possible.
      const { service, calls } = harness({ walked: [entry('a.ts', 'x')] });

      await service.indexProject(PROJECT_ID);

      expect(calls.updates.at(-1)).toMatchObject({
        embeddingModel: 'local:test-model',
        embeddingDim: 768,
      });
    });

    it('TC-IDX-052 ends in the ready status', async () => {
      const { service, calls } = harness({ walked: [entry('a.ts', 'x')] });
      await service.indexProject(PROJECT_ID);
      expect(calls.updates.at(-1)).toMatchObject({ status: 'ready' });
    });

    it('TC-IDX-053 emits phases in order and finishes on finalizing', async () => {
      const { service, progress, onProgress } = harness({
        walked: [entry('a.ts', 'x')],
      });

      await service.indexProject(PROJECT_ID, onProgress);

      const phases = progress.map((p) => p.phase);
      expect(phases[0]).toBe('walking');
      expect(phases).toContain('chunking');
      expect(phases).toContain('embedding');
      expect(phases.at(-1)).toBe('finalizing');
    });
  });

  it('TC-IDX-060 handles a repository with no indexable files', async () => {
    const { service, calls } = harness({
      walked: [],
      skipReasons: { binary: 3, extension: 10 },
    });

    const result = await service.indexProject(PROJECT_ID);

    expect(result).toBeDefined();
    expect(calls.replaced).toEqual([]);
    expect(calls.updates.at(-1)).toMatchObject({ status: 'ready' });
  });

  it('TC-IDX-061 releases file content after chunking to bound memory', async () => {
    // The walker's read is kept in memory; it must be drained as
    // chunking advances rather than held through the embedding phase.
    const entries = [
      entry('a.ts', 'const a = 1;'),
      entry('b.ts', 'const b = 2;'),
    ];
    const { service } = harness({ walked: entries });

    await service.indexProject(PROJECT_ID);

    for (const e of entries) {
      expect(e.text).toBe('');
      expect(e.lines).toEqual([]);
    }
  });
});
