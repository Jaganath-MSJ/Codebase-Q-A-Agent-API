import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createDbHarness,
  testDatabaseAvailable,
  skipReason,
  type DbHarness,
} from './db-harness';
import { runMigrations } from '../../src/db/migrate';
import { ProjectsRepository } from '../../src/db/repositories/projects.repository';
import { FilesRepository } from '../../src/db/repositories/files.repository';
import { ChunksRepository } from '../../src/db/repositories/chunks.repository';
import { JobsRepository } from '../../src/db/repositories/jobs.repository';
import { FtsRetriever } from '../../src/retrieval/fts.retriever';
import { TrigramRetriever } from '../../src/retrieval/trigram.retriever';
import { VectorRetriever } from '../../src/retrieval/vector.retriever';
import { ReferencesRetriever } from '../../src/retrieval/references.retriever';

/**
 * QA pass — TC-DB-1xx (repositories) and TC-RETR-* (retrievers).
 *
 * This is where the four retrievers deferred from L1 finally get tested. They
 * were skipped there deliberately: they are thin Drizzle query builders whose
 * only real behaviour is the SQL the database executes, so a fake-`db` test
 * would have asserted on generated SQL strings — testing Drizzle's codegen,
 * not this project's logic, and breaking on any Drizzle upgrade.
 *
 * Here the assertions are about *results*: does the right row come back, in
 * the right order, filtered to the right project.
 */

const available = await testDatabaseAvailable();

describe.skipIf(!available)(
  `Repositories and retrievers [${available ? 'live' : skipReason()}]`,
  () => {
    let h: DbHarness;
    let projects: ProjectsRepository;
    let files: FilesRepository;
    let chunks: ChunksRepository;
    let jobs: JobsRepository;
    let fts: FtsRetriever;
    let trigram: TrigramRetriever;
    let vector: VectorRetriever;
    let references: ReferencesRetriever;

    beforeAll(async () => {
      h = await createDbHarness();
      await runMigrations(h.db);
      projects = new ProjectsRepository(h.db);
      files = new FilesRepository(h.db);
      chunks = new ChunksRepository(h.db);
      jobs = new JobsRepository(h.db);
      fts = new FtsRetriever(h.db);
      trigram = new TrigramRetriever(h.db);
      vector = new VectorRetriever(h.db);
      references = new ReferencesRetriever(h.db);
    }, 120_000);

    beforeEach(async () => {
      await h.truncateAll();
    });

    afterAll(async () => {
      await h?.close();
    });

    // ------------------------------------------------------- repositories

    describe('TC-DB-100..106 — ProjectsRepository', () => {
      it('TC-DB-100 creates and reads back a project', async () => {
        const row = await projects.create({
          name: 'Demo',
          sourceRef: '/tmp/demo',
          sourceKind: 'local_path',
          defaultBranch: null,
        });
        expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(await projects.findById(row.id)).toMatchObject({ name: 'Demo' });
      });

      it('TC-DB-101 returns undefined for an unknown id', async () => {
        expect(
          await projects.findById('00000000-0000-4000-8000-000000000000'),
        ).toBeUndefined();
      });

      it('TC-DB-102 lists newest first', async () => {
        await projects.create({
          name: 'First',
          sourceRef: '/a',
          sourceKind: 'local_path',
          defaultBranch: null,
        });
        await new Promise((r) => setTimeout(r, 10));
        await projects.create({
          name: 'Second',
          sourceRef: '/b',
          sourceKind: 'local_path',
          defaultBranch: null,
        });
        const all = await projects.findAll();
        expect(all.map((p) => p.name)).toEqual(['Second', 'First']);
      });

      it('TC-DB-103 applies a partial update without clobbering other columns', async () => {
        const row = await projects.create({
          name: 'Demo',
          sourceRef: '/tmp/demo',
          sourceKind: 'local_path',
          defaultBranch: null,
        });
        await projects.update(row.id, { status: 'ready', fileCount: 7 });
        const after = await projects.findById(row.id);
        expect(after).toMatchObject({
          status: 'ready',
          fileCount: 7,
          name: 'Demo',
          sourceRef: '/tmp/demo',
        });
      });

      it('TC-DB-104 stores the 768-dimension stamp (INV-1)', async () => {
        const row = await projects.create({
          name: 'Demo',
          sourceRef: '/tmp/demo',
          sourceKind: 'local_path',
          defaultBranch: null,
        });
        await projects.update(row.id, {
          embeddingModel: 'local:model',
          embeddingDim: 768,
        });
        expect(await projects.findById(row.id)).toMatchObject({
          embeddingDim: 768,
        });
      });

      it('TC-DB-105 defaults a new project to a non-ready status', async () => {
        const row = await projects.create({
          name: 'Demo',
          sourceRef: '/tmp/demo',
          sourceKind: 'local_path',
          defaultBranch: null,
        });
        expect(row.status).not.toBe('ready');
      });

      it('TC-DB-106 returns an empty list when there are no projects', async () => {
        expect(await projects.findAll()).toEqual([]);
      });
    });

    describe('TC-DB-110..113 — FilesRepository', () => {
      it('TC-DB-110 lists every file for a project', async () => {
        const projectId = await seedProject();
        await seedFile(projectId, 'src/a.ts');
        await seedFile(projectId, 'src/b.ts');

        const found = await files.findAllByProjectId(projectId);
        expect(found.map((f) => f.path).sort()).toEqual([
          'src/a.ts',
          'src/b.ts',
        ]);
      });

      it('TC-DB-111 returns an empty array for a project with no files', async () => {
        expect(await files.findAllByProjectId(await seedProject())).toEqual([]);
      });

      it('TC-DB-112 scopes results to the project', async () => {
        const a = await seedProject('A');
        const b = await seedProject('B');
        await seedFile(a, 'shared.ts');
        await seedFile(b, 'shared.ts');

        const found = await files.findAllByProjectId(a);
        expect(found).toHaveLength(1);
      });

      it('TC-DB-113 deletes by id list and ignores unknown ids', async () => {
        const projectId = await seedProject();
        const keep = await seedFile(projectId, 'keep.ts');
        const drop = await seedFile(projectId, 'drop.ts');

        await files.deleteByIds([drop, '00000000-0000-4000-8000-000000000000']);

        const remaining = await files.findAllByProjectId(projectId);
        expect(remaining.map((f) => f.id)).toEqual([keep]);
      });

      it('TC-DB-114 deleteByIds with an empty list is a no-op', async () => {
        const projectId = await seedProject();
        await seedFile(projectId, 'keep.ts');
        await files.deleteByIds([]);
        expect(await files.findAllByProjectId(projectId)).toHaveLength(1);
      });
    });

    describe('TC-DB-120..123 — ChunksRepository', () => {
      it('TC-DB-120 counts chunks per project', async () => {
        const projectId = await seedProject();
        const fileId = await seedFile(projectId);
        await seedChunk(projectId, fileId, 0, 'alpha');
        await seedChunk(projectId, fileId, 1, 'beta');
        expect(await chunks.countByProjectId(projectId)).toBe(2);
      });

      it('TC-DB-121 finds chunks without an embedding', async () => {
        const projectId = await seedProject();
        const fileId = await seedFile(projectId);
        const withEmbedding = await seedChunk(projectId, fileId, 0, 'a');
        await seedChunk(projectId, fileId, 1, 'b');
        await setEmbedding(withEmbedding, 0.1);

        const pending = await chunks.findWithoutEmbedding(projectId);
        expect(pending).toHaveLength(1);
      });

      it('TC-DB-122 writes embeddings in bulk with two bound parameters', async () => {
        // One UPDATE ... FROM unnest(...) regardless of row count, to stay
        // clear of the 65535-parameter limit.
        const projectId = await seedProject();
        const fileId = await seedFile(projectId);
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
          ids.push(await seedChunk(projectId, fileId, i, `chunk ${i}`));
        }

        await chunks.setEmbeddingsBulk(
          ids.map((id) => ({ id, embedding: new Array(768).fill(0.2) })),
        );

        expect(await chunks.findWithoutEmbedding(projectId)).toHaveLength(0);
      });

      it('TC-DB-124 findByPaths groups chunks by path in one query (the N+1 fix)', async () => {
        // Lives on ChunksRepository (not FilesRepository) and returns a Map
        // keyed by path, each list in chunk order.
        const projectId = await seedProject();
        const fileA = await seedFile(projectId, 'src/a.ts');
        const fileB = await seedFile(projectId, 'src/b.ts');
        await seedChunk(projectId, fileA, 0, 'a-first');
        await seedChunk(projectId, fileA, 1, 'a-second');
        await seedChunk(projectId, fileB, 0, 'b-only');

        const byPath = await chunks.findByPaths(projectId, [
          'src/a.ts',
          'src/b.ts',
        ]);

        expect([...byPath.keys()].sort()).toEqual(['src/a.ts', 'src/b.ts']);
        expect(byPath.get('src/a.ts')!.map((c) => c.content)).toEqual([
          'a-first',
          'a-second',
        ]);
      });

      it('TC-DB-125 findByPaths returns an empty map for no paths', async () => {
        const projectId = await seedProject();
        expect((await chunks.findByPaths(projectId, [])).size).toBe(0);
      });

      it('TC-DB-126 findByPaths omits paths with no chunks', async () => {
        const projectId = await seedProject();
        const fileId = await seedFile(projectId, 'src/a.ts');
        await seedChunk(projectId, fileId, 0, 'only');

        const byPath = await chunks.findByPaths(projectId, [
          'src/a.ts',
          'src/missing.ts',
        ]);
        expect([...byPath.keys()]).toEqual(['src/a.ts']);
      });

      it('TC-DB-123 leaves other projects untouched when counting', async () => {
        const a = await seedProject('A');
        const b = await seedProject('B');
        const fileA = await seedFile(a);
        const fileB = await seedFile(b);
        await seedChunk(a, fileA, 0, 'x');
        await seedChunk(b, fileB, 0, 'y');
        await seedChunk(b, fileB, 1, 'z');

        expect(await chunks.countByProjectId(a)).toBe(1);
        expect(await chunks.countByProjectId(b)).toBe(2);
      });
    });

    describe('TC-DB-130..135 — JobsRepository (CONC)', () => {
      it('TC-DB-130 enqueues and finds the latest job', async () => {
        const projectId = await seedProject();
        const job = await jobs.enqueue(projectId, 'initial');
        expect(await jobs.findLatestByProject(projectId)).toMatchObject({
          id: job.id,
        });
      });

      it('TC-DB-131 rejects a second active job for the same project', async () => {
        const projectId = await seedProject();
        await jobs.enqueue(projectId, 'initial');
        await expect(jobs.enqueue(projectId, 'initial')).rejects.toThrow();
      });

      it('TC-DB-132 claimNext returns a queued job exactly once', async () => {
        // The lease. Two workers draining concurrently must not both get it.
        const projectId = await seedProject();
        await jobs.enqueue(projectId, 'initial');

        const [first, second] = await Promise.all([
          jobs.claimNext(),
          jobs.claimNext(),
        ]);

        const claimed = [first, second].filter(Boolean);
        expect(claimed).toHaveLength(1);
      });

      it('TC-DB-133 claimNext returns undefined when the queue is empty', async () => {
        expect(await jobs.claimNext()).toBeUndefined();
      });

      it('TC-DB-134 marks a job succeeded and frees the project for a new one', async () => {
        const projectId = await seedProject();
        const job = await jobs.enqueue(projectId, 'initial');
        await jobs.markSucceeded(job.id);

        expect(await jobs.findById(job.id)).toMatchObject({
          status: 'succeeded',
        });
        await expect(jobs.enqueue(projectId, 'initial')).resolves.toBeDefined();
      });

      it('TC-DB-135 records a failure message', async () => {
        const projectId = await seedProject();
        const job = await jobs.enqueue(projectId, 'initial');
        await jobs.markFailed(job.id, 'chunker exploded');
        expect(await jobs.findById(job.id)).toMatchObject({
          status: 'failed',
          errorMessage: 'chunker exploded',
        });
      });
    });

    // --------------------------------------------------------- retrievers

    describe('TC-RETR-001..008 — full-text and trigram', () => {
      it('TC-RETR-001 FTS finds a chunk by an identifier in its search text', async () => {
        const projectId = await seedProject();
        const fileId = await seedFile(projectId);
        await seedChunk(
          projectId,
          fileId,
          0,
          'export function validateUser() {}',
          'validateUser authentication',
        );

        const hits = await fts.search(projectId, 'validateUser');
        expect(hits).toHaveLength(1);
        expect(hits[0]!.path).toBe('src/a.ts');
      });

      it('TC-RETR-002 FTS ORs its terms, so one missing filler word does not zero the match', async () => {
        // websearch_to_tsquery ANDs by default; the retriever joins with " or "
        // precisely so "where is validateUser" still matches.
        const projectId = await seedProject();
        const fileId = await seedFile(projectId);
        await seedChunk(projectId, fileId, 0, 'code', 'validateUser');

        const hits = await fts.search(projectId, 'where is validateUser');
        expect(hits).toHaveLength(1);
      });

      it('TC-RETR-003 FTS returns nothing for an unmatched term', async () => {
        const projectId = await seedProject();
        const fileId = await seedFile(projectId);
        await seedChunk(projectId, fileId, 0, 'code', 'validateUser');
        expect(await fts.search(projectId, 'zzzznotpresent')).toEqual([]);
      });

      it('TC-RETR-004 FTS is scoped to one project', async () => {
        const a = await seedProject('A');
        const b = await seedProject('B');
        await seedChunk(a, await seedFile(a), 0, 'code', 'sharedTerm');
        await seedChunk(b, await seedFile(b), 0, 'code', 'sharedTerm');

        const hits = await fts.search(a, 'sharedTerm');
        expect(hits).toHaveLength(1);
      });

      it('TC-RETR-005 FTS honours the limit', async () => {
        const projectId = await seedProject();
        const fileId = await seedFile(projectId);
        for (let i = 0; i < 5; i++) {
          await seedChunk(projectId, fileId, i, 'code', 'commonTerm');
        }
        expect(await fts.search(projectId, 'commonTerm', 2)).toHaveLength(2);
      });

      it('TC-RETR-006 trigram matches a near-miss identifier', async () => {
        // word_similarity, not similarity — the whole-string ratio would be
        // swamped by chunk size and score near zero.
        const projectId = await seedProject();
        const fileId = await seedFile(projectId);
        await seedChunk(
          projectId,
          fileId,
          0,
          'code',
          'validateUser ' + 'filler '.repeat(100),
        );

        const hits = await trigram.search(projectId, 'validateUsr');
        expect(hits.length).toBeGreaterThan(0);
      });

      it('TC-RETR-007 references finds exact lexeme matches only', async () => {
        const projectId = await seedProject();
        const fileId = await seedFile(projectId);
        await seedChunk(projectId, fileId, 0, 'code', 'validateUser');
        await seedChunk(projectId, fileId, 1, 'code', 'revalidateUserToken');

        const hits = await references.findReferences(projectId, 'validateUser');
        // 'simple' tokenisation makes validateUser one whole lexeme, so the
        // longer identifier must NOT match the way a substring search would.
        expect(hits).toHaveLength(1);
      });

      it('TC-RETR-008 references orders by path then start line', async () => {
        const projectId = await seedProject();
        const fileB = await seedFile(projectId, 'src/b.ts');
        const fileA = await seedFile(projectId, 'src/a.ts');
        await seedChunk(projectId, fileB, 0, 'code', 'target', 10);
        await seedChunk(projectId, fileA, 0, 'code', 'target', 20);
        await seedChunk(projectId, fileA, 1, 'code', 'target', 5);

        const hits = await references.findReferences(projectId, 'target');
        expect(hits.map((r) => [r.path, r.startLine])).toEqual([
          ['src/a.ts', 5],
          ['src/a.ts', 20],
          ['src/b.ts', 10],
        ]);
      });
    });

    describe('TC-RETR-010..013 — vector search (INV-1)', () => {
      it('TC-RETR-010 returns the nearest chunk first', async () => {
        const projectId = await seedProject();
        const fileId = await seedFile(projectId);
        const near = await seedChunk(projectId, fileId, 0, 'near');
        const far = await seedChunk(projectId, fileId, 1, 'far');

        // Two clearly separated directions in 768-space.
        await setEmbeddingVector(near, unitVector(0));
        await setEmbeddingVector(far, unitVector(1));

        const hits = await vector.search(projectId, unitVector(0), 10);
        expect(hits[0]!.chunkId).toBe(near);
        expect(hits.map((hit) => hit.chunkId)).toContain(far);
      });

      it('TC-RETR-011 ignores chunks with no embedding', async () => {
        const projectId = await seedProject();
        const fileId = await seedFile(projectId);
        const embedded = await seedChunk(projectId, fileId, 0, 'a');
        await seedChunk(projectId, fileId, 1, 'b'); // no embedding
        await setEmbeddingVector(embedded, unitVector(0));

        const hits = await vector.search(projectId, unitVector(0), 10);
        expect(hits).toHaveLength(1);
      });

      it('TC-RETR-012 is scoped to one project', async () => {
        const a = await seedProject('A');
        const b = await seedProject('B');
        const chunkA = await seedChunk(a, await seedFile(a), 0, 'a');
        const chunkB = await seedChunk(b, await seedFile(b), 0, 'b');
        await setEmbeddingVector(chunkA, unitVector(0));
        await setEmbeddingVector(chunkB, unitVector(0));

        const hits = await vector.search(a, unitVector(0), 10);
        expect(hits).toHaveLength(1);
        expect(hits[0]!.chunkId).toBe(chunkA);
      });

      it('TC-RETR-013 honours the limit', async () => {
        const projectId = await seedProject();
        const fileId = await seedFile(projectId);
        for (let i = 0; i < 5; i++) {
          const id = await seedChunk(projectId, fileId, i, `c${i}`);
          await setEmbeddingVector(id, unitVector(i % 3));
        }
        expect(await vector.search(projectId, unitVector(0), 2)).toHaveLength(
          2,
        );
      });
    });

    // ------------------------------------------------------- seed helpers

    async function seedProject(name = 'QA Project'): Promise<string> {
      const row = await projects.create({
        name,
        sourceRef: `/tmp/${name}`,
        sourceKind: 'local_path',
        defaultBranch: null,
      });
      return row.id;
    }

    async function seedFile(
      projectId: string,
      path = 'src/a.ts',
    ): Promise<string> {
      const row = await h.row<{ id: string }>(sql`
        insert into files (project_id, path, lang, content_hash, line_count)
        values (${projectId}, ${path}, 'ts', ${'hash-' + path}, 10)
        returning id
      `);
      return row!.id;
    }

    async function seedChunk(
      projectId: string,
      fileId: string,
      ord: number,
      content: string,
      searchText = content,
      startLine = 1,
    ): Promise<string> {
      const row = await h.row<{ id: string }>(sql`
        insert into chunks (project_id, file_id, ord, start_line, end_line, content, content_hash, search_text)
        values (${projectId}, ${fileId}, ${ord}, ${startLine}, ${startLine + 5}, ${content}, ${'h' + ord + startLine}, ${searchText})
        returning id
      `);
      return row!.id;
    }

    async function setEmbedding(chunkId: string, fill: number): Promise<void> {
      await setEmbeddingVector(chunkId, new Array<number>(768).fill(fill));
    }

    async function setEmbeddingVector(
      chunkId: string,
      values: number[],
    ): Promise<void> {
      const literal = `[${values.join(',')}]`;
      await h.db.execute(
        sql`update chunks set embedding = ${literal}::halfvec where id = ${chunkId}`,
      );
    }

    /** A 768-dim unit vector pointing along one axis — trivially separable. */
    function unitVector(axis: number): number[] {
      const v = new Array<number>(768).fill(0);
      v[axis] = 1;
      return v;
    }
  },
);
