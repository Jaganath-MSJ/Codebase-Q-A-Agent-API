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
      // Names the tool, not the driver. Forwarding `err.message` here was the
      // DEF-004 leak; the executor's own message stays in the server log.
      expect(result.note).toBe('Error: search_code failed.');
      expect(result.note).not.toContain('retriever exploded');
    });

    it('TC-TOOL-921 handles a non-Error rejection', async () => {
      const exploding = new ToolRegistry(
        {
          // Rejecting with a non-Error is exactly what this test exercises —
          // the registry must survive a value with no `.message` and no
          // `.code`. The lint rule is right in general, suppressed here.
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
      expect(result.note).toBe('Error: search_code failed.');
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

    it('TC-TOOL-923 [DEFECT-004 fixed] never puts the absolute workspace path in the note the model reads', async () => {
      // Was the S2 leak: `read_file` on a directory raises EISDIR, which
      // propagated to the catch-all below, where `err.message` — containing the
      // absolute host path — became the note fed back to the LLM. CLAUDE.md
      // states workspace_path is server-side only and never leaves the server.
      expect(path.isAbsolute(workspace)).toBe(true);

      const result = await registry.execute(PROJECT_ID, {
        name: 'read_file',
        args: { path: 'src' },
      } as never);

      expect(result.note).not.toContain(workspace);
      // Still useful to the model, which is the point — a redaction that leaves
      // it unable to recover would just trade one defect for another.
      expect(result.note).toContain('directory');
    });

    it('TC-TOOL-924 [DEFECT-004 fixed] never puts SQL or bound parameters in the note', async () => {
      // The wider half of DEF-004, found on re-verification: every executor
      // funnels into the same catch, and drizzle builds its message as
      // "Failed query: <SQL>\nparams: <params>". For search_code those params
      // are the 768-float query embedding, which alone overruns the agent
      // loop's 4,000-character result budget.
      const failing = {
        search: () =>
          Promise.reject(
            new Error(
              'Failed query: select * from chunks where project_id = $1\nparams: p-1,0.11,0.22',
            ),
          ),
      } as unknown as RetrievalService;
      const isolated = new ToolRegistry(
        failing,
        {
          findById: () => Promise.resolve({ workspacePath: workspace }),
        } as unknown as ProjectsRepository,
        {
          findAllByProjectId: () => Promise.resolve([]),
        } as unknown as FilesRepository,
      );

      const result = await isolated.execute(PROJECT_ID, {
        name: 'search_code',
        args: { query: 'auth' },
      } as never);

      expect(result.note).not.toContain('Failed query');
      expect(result.note).not.toContain('params:');
      expect(result.note).not.toContain('select');
      expect(result.note).toBe('Error: search_code failed.');
    });

    it('TC-TOOL-925 keeps the error code, which is what the model can act on', async () => {
      // The fix must not flatten every failure into one opaque string: a code
      // distinguishes "you asked for the wrong thing" from "the server broke".
      const failing = {
        search: () =>
          Promise.reject(
            Object.assign(new Error('relation "chunks" does not exist'), {
              code: '42P01',
            }),
          ),
      } as unknown as RetrievalService;
      const isolated = new ToolRegistry(
        failing,
        {
          findById: () => Promise.resolve({ workspacePath: workspace }),
        } as unknown as ProjectsRepository,
        {
          findAllByProjectId: () => Promise.resolve([]),
        } as unknown as FilesRepository,
      );

      const result = await isolated.execute(PROJECT_ID, {
        name: 'search_code',
        args: { query: 'auth' },
      } as never);

      expect(result.note).toBe('Error: search_code failed (42P01).');
      expect(result.note).not.toContain('relation');
    });
  });
});
