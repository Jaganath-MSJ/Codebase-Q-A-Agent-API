import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ToolRegistry } from './tool.registry';
import type { RetrievalService } from '../retrieval/retrieval.service';
import type { ProjectsRepository } from '../db/repositories/projects.repository';
import type { FilesRepository } from '../db/repositories/files.repository';

/** QA pass — TC-TOOL-9xx: dispatch and the never-throws contract. */

const PROJECT_ID = 'p-1';

describe('ToolRegistry', () => {
  let workspace: string;
  let registry: ToolRegistry;

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'qa-registry-'));
    await mkdir(path.join(workspace, 'src'), { recursive: true });
    await writeFile(path.join(workspace, 'src', 'a.ts'), 'line one\nline two');

    const retrieval = {
      search: () =>
        Promise.resolve([
          {
            path: 'src/a.ts',
            startLine: 1,
            endLine: 2,
            content: 'line one\nline two',
          },
        ]),
      findReferences: () =>
        Promise.resolve([{ path: 'src/a.ts', startLine: 1, endLine: 1 }]),
    } as unknown as RetrievalService;

    const projects = {
      findById: () =>
        Promise.resolve({ workspacePath: workspace, sourceRef: workspace }),
    } as unknown as ProjectsRepository;

    const files = {
      findAllByProjectId: () => Promise.resolve([{ path: 'src/a.ts' }]),
    } as unknown as FilesRepository;

    registry = new ToolRegistry(retrieval, projects, files);
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  describe('TC-TOOL-900..902 — definitions', () => {
    it('TC-TOOL-900 exposes exactly the four agentic tools', () => {
      expect(registry.definitions.map((d) => d.name)).toEqual([
        'search_code',
        'read_file',
        'list_files',
        'find_references',
      ]);
    });

    it('TC-TOOL-901 gives every definition a description and parameter schema', () => {
      for (const def of registry.definitions) {
        expect(def.description.length).toBeGreaterThan(0);
        expect(def.parameters.type).toBe('object');
        expect(Array.isArray(def.parameters.required)).toBe(true);
      }
    });

    it('TC-TOOL-902 uses unique tool names', () => {
      const names = registry.definitions.map((d) => d.name);
      expect(new Set(names).size).toBe(names.length);
    });
  });

  describe('TC-TOOL-910..914 — dispatch', () => {
    it('TC-TOOL-910 routes search_code', async () => {
      const result = await registry.execute(PROJECT_ID, {
        name: 'search_code',
        args: { query: 'x' },
      } as never);
      expect(result.regions).toHaveLength(1);
    });

    it('TC-TOOL-911 routes read_file', async () => {
      const result = await registry.execute(PROJECT_ID, {
        name: 'read_file',
        args: { path: 'src/a.ts' },
      } as never);
      expect(result.regions[0]!.content).toBe('line one\nline two');
    });

    it('TC-TOOL-912 routes list_files', async () => {
      const result = await registry.execute(PROJECT_ID, {
        name: 'list_files',
        args: { glob: '**/*.ts' },
      } as never);
      expect(result.note).toBe('src/a.ts');
    });

    it('TC-TOOL-913 routes find_references', async () => {
      const result = await registry.execute(PROJECT_ID, {
        name: 'find_references',
        args: { symbol: 'foo' },
      } as never);
      expect(result.note).toBe('src/a.ts: 1-1');
    });

    it('TC-TOOL-914 reports an unknown tool name as a note', async () => {
      const result = await registry.execute(PROJECT_ID, {
        name: 'rm_rf',
        args: {},
      } as never);
      expect(result.regions).toEqual([]);
      expect(result.note).toBe('Error: unknown tool "rm_rf".');
    });
  });

  describe('TC-TOOL-920..923 — the never-throws contract', () => {
    /**
     * A thrown tool error would kill the agent loop mid-turn. The registry
     * converts every failure into text the model can read and react to.
     */
    it('TC-TOOL-920 converts a thrown executor error into a note', async () => {
      const exploding = new ToolRegistry(
        {
          search: () => Promise.reject(new Error('retriever exploded')),
        } as unknown as RetrievalService,
        {} as ProjectsRepository,
        {} as FilesRepository,
      );
      const result = await exploding.execute(PROJECT_ID, {
        name: 'search_code',
        args: { query: 'x' },
      } as never);
      expect(result.regions).toEqual([]);
      expect(result.note).toBe('Error: retriever exploded');
    });

    it('TC-TOOL-921 handles a non-Error rejection', async () => {
      const exploding = new ToolRegistry(
        {
          // Rejecting with a non-Error is exactly what this test exercises —
          // the registry's `err instanceof Error` branch. The lint rule is
          // right in general and deliberately suppressed here.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          search: () => Promise.reject('just a string'),
        } as unknown as RetrievalService,
        {} as ProjectsRepository,
        {} as FilesRepository,
      );
      const result = await exploding.execute(PROJECT_ID, {
        name: 'search_code',
        args: { query: 'x' },
      } as never);
      expect(result.note).toBe('Error: Unknown error');
    });

    it('TC-TOOL-922 never throws for any tool given hostile arguments', async () => {
      const hostile = [
        { name: 'read_file', args: { path: '../../../etc/passwd' } },
        { name: 'read_file', args: {} },
        { name: 'list_files', args: { glob: '*'.repeat(500) } },
        { name: 'search_code', args: { query: '' } },
        { name: 'find_references', args: { symbol: null } },
        { name: 'unknown', args: {} },
      ];
      for (const call of hostile) {
        await expect(
          registry.execute(PROJECT_ID, call as never),
        ).resolves.toBeDefined();
      }
    });

    it('TC-TOOL-923 [DEFECT-004] leaks the absolute workspace path into the note the model reads', async () => {
      // `read_file` on a directory raises EISDIR, which is not the ENOENT the
      // tool handles, so it propagates here and `err.message` — containing the
      // absolute host path — becomes the note fed back to the LLM. CLAUDE.md
      // states workspace_path is server-side only and never leaves the server.
      // Documented, not fixed: this phase changes no product code.
      const result = await registry.execute(PROJECT_ID, {
        name: 'read_file',
        args: { path: 'src' },
      } as never);
      expect(result.note).toContain('EISDIR');
      expect(result.note).toContain(workspace);
      expect(path.isAbsolute(workspace)).toBe(true);
    });
  });
});
