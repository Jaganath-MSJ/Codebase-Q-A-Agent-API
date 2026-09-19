import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createDbHarness,
  testDatabaseAvailable,
  skipReason,
  expectPgError,
  PG,
  type DbHarness,
} from './db-harness';
import { runMigrations } from '../../src/db/migrate';

/**
 * QA pass — TC-DB-0xx.
 *
 * Migrations and schema shape against a real Postgres. These assertions are
 * impossible at L1 or L2: the halfvec dimension, the HNSW opclass and the
 * index set exist only in SQL, and a mistake in any of them is silent —
 * retrieval still "works", just worse, or writes fail much later with a
 * cryptic dimension error.
 */

const available = await testDatabaseAvailable();

describe.skipIf(!available)(
  `Database schema [${available ? 'live' : skipReason()}]`,
  () => {
    let h: DbHarness;

    beforeAll(async () => {
      h = await createDbHarness();
      // Migrations are the thing under test; run them before anything else.
      await runMigrations(h.db);
    }, 120_000);

    beforeEach(async () => {
      await h.truncateAll();
    });

    afterAll(async () => {
      await h?.close();
    });

    // ------------------------------------------------------- seed helpers

    async function seedProject(name = 'QA Project'): Promise<string> {
      const row = await h.row<{ id: string }>(sql`
        insert into projects (name, source_kind, source_ref)
        values (${name}, 'local_path', ${'/tmp/' + name}) returning id
      `);
      return row!.id;
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
      ord = 0,
      searchText = 'x',
    ): Promise<string> {
      const row = await h.row<{ id: string }>(sql`
        insert into chunks (project_id, file_id, ord, start_line, end_line, content, content_hash, search_text)
        values (${projectId}, ${fileId}, ${ord}, 1, 1, 'x', ${'h' + ord}, ${searchText})
        returning id
      `);
      return row!.id;
    }

    const countOf = async (
      table: string,
      projectId: string,
    ): Promise<number> => {
      const row = await h.row<{ n: number }>(
        sql.raw(
          `select count(*)::int as n from ${table} where project_id = '${projectId}'`,
        ),
      );
      return row!.n;
    };

    // ---------------------------------------------------------- migrations

    describe('TC-DB-001..004 — migrations', () => {
      it('TC-DB-001 applies cleanly and records a journal', async () => {
        const row = await h.row<{ n: number }>(
          sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
        );
        expect(row!.n).toBeGreaterThan(0);
      });

      it('TC-DB-002 is idempotent — re-running applies nothing new', async () => {
        const before = await h.row<{ n: number }>(
          sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
        );
        await runMigrations(h.db);
        const after = await h.row<{ n: number }>(
          sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
        );
        expect(after!.n).toBe(before!.n);
      }, 60_000);

      it('TC-DB-003 creates every expected table', async () => {
        const names = (
          await h.rows<{ table_name: string }>(sql`
            select table_name from information_schema.tables
            where table_schema = 'public' order by table_name
          `)
        ).map((r) => r.table_name);

        for (const expected of [
          'projects',
          'files',
          'chunks',
          'indexing_jobs',
          'conversations',
          'conversation_projects',
          'messages',
          'citations',
          // Note the name: source_credentials, not credentials.
          'source_credentials',
        ]) {
          expect(names, `missing table ${expected}`).toContain(expected);
        }
      });

      it('TC-DB-004 installs the vector and pg_trgm extensions', async () => {
        const names = (
          await h.rows<{ extname: string }>(
            sql`select extname from pg_extension order by extname`,
          )
        ).map((r) => r.extname);
        expect(names).toContain('vector');
        expect(names).toContain('pg_trgm');
      });
    });

    // ------------------------------------------------ INV-1 at the storage layer

    describe('TC-DB-010..014 — INV-1, the embedding column', () => {
      it('TC-DB-010 chunks.embedding is halfvec with exactly 768 dimensions', async () => {
        // INV-1 at the storage layer. The type is halfvec (16-bit floats), NOT
        // vector — pgvector's negligible-recall-loss halving, chosen in the
        // schema. Asserting `vector` here would fail, correctly.
        const row = await h.row<{ type: string }>(sql`
          select format_type(atttypid, atttypmod) as type
          from pg_attribute
          where attrelid = 'chunks'::regclass and attname = 'embedding'
        `);
        expect(row!.type).toMatch(/halfvec\(768\)/);
      });

      it('TC-DB-011 rejects a vector of the wrong dimension at write time', async () => {
        // The database is the last line of defence for INV-1 — even if the
        // index-time assertion (TC-IDX-040) were removed, this still fails.
        const projectId = await seedProject();
        const chunkId = await seedChunk(projectId, await seedFile(projectId));
        const wrongDim = `[${new Array<number>(512).fill(0.1).join(',')}]`;

        // Assert the SQLSTATE, not the message: drizzle wraps driver errors in
        // its own "Failed query: ..." Error, so matching text would pass for
        // ANY failure — including one that has nothing to do with dimensions.
        await expectPgError(
          h.db.execute(
            sql`update chunks set embedding = ${wrongDim}::halfvec where id = ${chunkId}`,
          ),
          PG.DATA_EXCEPTION,
        );
      });

      it('TC-DB-012 accepts a correctly sized vector', async () => {
        const projectId = await seedProject();
        const chunkId = await seedChunk(projectId, await seedFile(projectId));
        const right = `[${new Array<number>(768).fill(0.1).join(',')}]`;

        await expect(
          h.db.execute(
            sql`update chunks set embedding = ${right}::halfvec where id = ${chunkId}`,
          ),
        ).resolves.toBeDefined();
      });

      it('TC-DB-013 has the HNSW index with the halfvec_cosine_ops opclass', async () => {
        // The opclass MUST match the column type and the distance operator the
        // retriever uses (<=>). A vector_* opclass would simply never be chosen
        // by the planner — the query still works, just without the index.
        const row = await h.row<{ indexdef: string }>(sql`
          select indexdef from pg_indexes
          where tablename = 'chunks' and indexname = 'chunks_embedding_hnsw'
        `);
        expect(row, 'chunks_embedding_hnsw is missing').toBeDefined();
        expect(row!.indexdef).toMatch(/USING hnsw/i);
        expect(row!.indexdef).toMatch(/halfvec_cosine_ops/);
      });

      it('TC-DB-014 has the indexes later phases added for performance', async () => {
        const names = (
          await h.rows<{ indexname: string }>(
            sql`select indexname from pg_indexes where schemaname = 'public'`,
          )
        ).map((r) => r.indexname);

        expect(names).toContain('chunks_project_id_idx');
        expect(names).toContain('indexing_jobs_project_id_created_idx');
        expect(names).toContain('chunks_tsv_gin');
        expect(names).toContain('chunks_trgm_gin');
      });
    });

    // ------------------------------------- generated columns and constraints

    describe('TC-DB-020..023 — generated columns and constraints', () => {
      it('TC-DB-020 populates the tsv column automatically from search_text', async () => {
        const projectId = await seedProject();
        await seedChunk(
          projectId,
          await seedFile(projectId),
          0,
          'validateUser authentication',
        );

        const row = await h.row<{ tsv: string }>(
          sql`select tsv::text as tsv from chunks where project_id = ${projectId}`,
        );
        expect(row!.tsv).toContain('validateuser');
      });

      it('TC-DB-021 enforces the unique chunk ordinal per file', async () => {
        const projectId = await seedProject();
        const fileId = await seedFile(projectId);
        await seedChunk(projectId, fileId, 0);

        await expectPgError(
          seedChunk(projectId, fileId, 0),
          PG.UNIQUE_VIOLATION,
        );
      });

      it('TC-DB-022 allows only one active indexing job per project (CONC)', async () => {
        // The partial unique index behind the 409 in TC-JOB-020. Two concurrent
        // "Re-index" clicks must not both become running jobs.
        const projectId = await seedProject();
        const enqueue = () =>
          h.db.execute(sql`
            insert into indexing_jobs (project_id, trigger, status)
            values (${projectId}, 'initial', 'queued')
          `);

        await enqueue();
        await expectPgError(enqueue(), PG.UNIQUE_VIOLATION);
      });

      it('TC-DB-023 permits a new job once the previous one is terminal', async () => {
        const projectId = await seedProject();
        await h.db.execute(sql`
          insert into indexing_jobs (project_id, trigger, status)
          values (${projectId}, 'initial', 'succeeded')
        `);

        await expect(
          h.db.execute(sql`
            insert into indexing_jobs (project_id, trigger, status)
            values (${projectId}, 'initial', 'queued')
          `),
        ).resolves.toBeDefined();
      });
    });

    // ------------------------------------------------------ cascade deletes

    describe('TC-DB-030..034 — cascade deletes', () => {
      it('TC-DB-030 deleting a project removes its files and chunks', async () => {
        const projectId = await seedProject();
        await seedChunk(projectId, await seedFile(projectId));

        await h.db.execute(sql`delete from projects where id = ${projectId}`);

        expect(await countOf('files', projectId)).toBe(0);
        expect(await countOf('chunks', projectId)).toBe(0);
      });

      it('TC-DB-031 deleting a project removes its indexing jobs', async () => {
        const projectId = await seedProject();
        await h.db.execute(sql`
          insert into indexing_jobs (project_id, trigger, status)
          values (${projectId}, 'initial', 'queued')
        `);

        await h.db.execute(sql`delete from projects where id = ${projectId}`);

        expect(await countOf('indexing_jobs', projectId)).toBe(0);
      });

      it('TC-DB-032 deleting a file removes only its own chunks', async () => {
        const projectId = await seedProject();
        const keepFile = await seedFile(projectId, 'keep.ts');
        const dropFile = await seedFile(projectId, 'drop.ts');
        await seedChunk(projectId, keepFile, 0);
        await seedChunk(projectId, dropFile, 1);

        await h.db.execute(sql`delete from files where id = ${dropFile}`);

        const remaining = await h.rows<{ file_id: string }>(
          sql`select file_id from chunks where project_id = ${projectId}`,
        );
        expect(remaining.map((r) => r.file_id)).toEqual([keepFile]);
      });

      it('TC-DB-033 deleting a conversation removes its messages and citations', async () => {
        const projectId = await seedProject();
        const conversation = await h.row<{ id: string }>(sql`
          insert into conversations (project_id) values (${projectId}) returning id
        `);
        const message = await h.row<{ id: string }>(sql`
          insert into messages (conversation_id, role, content, status)
          values (${conversation!.id}, 'assistant', 'hi', 'complete') returning id
        `);
        await h.db.execute(sql`
          insert into citations (message_id, project_id, marker, file_path, start_line, end_line, used)
          values (${message!.id}, ${projectId}, 1, 'src/a.ts', 1, 5, true)
        `);

        await h.db.execute(
          sql`delete from conversations where id = ${conversation!.id}`,
        );

        const citations = await h.row<{ n: number }>(
          sql`select count(*)::int as n from citations where message_id = ${message!.id}`,
        );
        const messages = await h.row<{ n: number }>(
          sql`select count(*)::int as n from messages where conversation_id = ${conversation!.id}`,
        );
        expect(citations!.n).toBe(0);
        expect(messages!.n).toBe(0);
      });

      it('TC-DB-034 leaves no orphans anywhere after a project delete', async () => {
        const projectId = await seedProject();
        await seedChunk(projectId, await seedFile(projectId));
        const conversation = await h.row<{ id: string }>(sql`
          insert into conversations (project_id) values (${projectId}) returning id
        `);
        await h.db.execute(sql`
          insert into messages (conversation_id, role, content, status)
          values (${conversation!.id}, 'user', 'q', 'complete')
        `);

        await h.db.execute(sql`delete from projects where id = ${projectId}`);

        for (const table of ['files', 'chunks', 'indexing_jobs']) {
          expect(await countOf(table, projectId), table).toBe(0);
        }
        const conversations = await h.row<{ n: number }>(
          sql`select count(*)::int as n from conversations where project_id = ${projectId}`,
        );
        expect(conversations!.n).toBe(0);
      });
    });
  },
);
