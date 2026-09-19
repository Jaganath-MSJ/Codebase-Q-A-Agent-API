import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { createHarness, json, VALID_UUID, type Harness } from './harness';
import { TourService } from '../src/tour/tour.service';
import { ChangeAnalysisService } from '../src/change-analysis/change-analysis.service';
import { RetrievalService } from '../src/retrieval/retrieval.service';
import { ProvidersService } from '../src/providers/providers.service';

/**
 * QA pass — TC-MISC-*.
 *
 * Tour, change-analysis, search, uploads and providers.
 *
 * The tour/changes pair carries the most contract nuance in the codebase: both
 * return a **status envelope with 200 in every state** (Phase 13.5), because
 * the old 404-for-"not yet" made the client poll forever. The `absent` state is
 * the regression that fix was for, and it is asserted directly.
 */

const tourRecord = {
  summary: 'This repo indexes codebases.',
  sections: [{ title: 'Entry points', body: 'main.ts', citations: [] }],
  generatedAt: '2026-01-01T00:00:00.000Z',
};

const analysisRecord = {
  commitHash: 'abc1234',
  commitMessage: 'feat: add retrieval',
  changedFiles: ['src/a.ts'],
  summary: 'Adds a retriever.',
  citations: [],
  generatedAt: '2026-01-01T00:00:00.000Z',
};

describe('Tour, changes, search, uploads and providers routes', () => {
  let h: Harness;
  let tourStatus: { status: string; tour: unknown } = {
    status: 'ready',
    tour: tourRecord,
  };
  let analysisStatus: { status: string; analysis: unknown } = {
    status: 'ready',
    analysis: analysisRecord,
  };
  let tourGenerateCalls = 0;
  let searchArgs: unknown[] = [];

  beforeAll(async () => {
    h = await createHarness({
      overrides: [
        {
          provide: TourService,
          useValue: {
            getTourStatus: () => Promise.resolve(tourStatus),
            // DEF-020: the POST route now awaits this before scheduling, so a
            // fabricated project id 404s instead of returning 202. These tests
            // use VALID_UUID, which exists.
            assertProjectExists: () => Promise.resolve(undefined),
            generate: () => {
              tourGenerateCalls++;
              return Promise.resolve(undefined);
            },
          },
        },
        {
          provide: ChangeAnalysisService,
          useValue: {
            getAnalysisStatus: () => Promise.resolve(analysisStatus),
            generate: () => Promise.resolve(undefined),
          },
        },
        {
          provide: RetrievalService,
          useValue: {
            search: (...args: unknown[]) => {
              searchArgs = args;
              return Promise.resolve([
                {
                  chunkId: 'chunk-1',
                  path: 'src/auth.ts',
                  startLine: 1,
                  endLine: 10,
                  content: 'export function validateUser() {}',
                  contentHash: 'deadbeef',
                  symbol: 'validateUser',
                  score: 0.91,
                },
              ]);
            },
          },
        },
        {
          provide: ProvidersService,
          useValue: {
            getStatus: () =>
              Promise.resolve({
                embedding: { id: 'local:model', healthy: true },
                chat: { id: 'gemini:flash', healthy: true },
                embedRequestsToday: 12,
                embedDailyLimit: 900,
              }),
          },
        },
      ],
    });
  });

  afterAll(async () => {
    await h.close();
  });

  // ---------------------------------------------- GET /projects/:id/tour

  describe('TC-MISC-100..108 — GET tour (status envelope)', () => {
    it('TC-MISC-100 returns 200 with a ready tour', async () => {
      tourStatus = { status: 'ready', tour: tourRecord };
      const res = await h.request(`/projects/${VALID_UUID}/tour`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'ready' });
    });

    it('TC-MISC-101 returns 200 — never 404 — while generating', async () => {
      tourStatus = { status: 'generating', tour: null };
      const res = await h.request(`/projects/${VALID_UUID}/tour`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'generating', tour: null });
    });

    it('TC-MISC-102 returns 200 with status "absent" when there is nothing', async () => {
      // THE Phase 13.5 regression: this used to 404, and the client polled
      // forever. `absent` is how the client knows to stop.
      tourStatus = { status: 'absent', tour: null };
      const res = await h.request(`/projects/${VALID_UUID}/tour`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'absent', tour: null });
    });

    it('TC-MISC-103 always includes both envelope keys', async () => {
      for (const status of ['ready', 'generating', 'absent']) {
        tourStatus = {
          status,
          tour: status === 'ready' ? tourRecord : null,
        };
        const res = await h.request(`/projects/${VALID_UUID}/tour`);
        expect(Object.keys(res.body as object).sort(), status).toEqual([
          'status',
          'tour',
        ]);
      }
    });

    it('TC-MISC-104 maps the record to the documented TourDto', async () => {
      tourStatus = { status: 'ready', tour: tourRecord };
      const body = (await h.request(`/projects/${VALID_UUID}/tour`)).body as {
        tour: Record<string, unknown>;
      };
      expect(Object.keys(body.tour).sort()).toEqual([
        'generatedAt',
        'sections',
        'summary',
      ]);
    });

    it('TC-MISC-105 returns 400 for a malformed project id', async () => {
      expect((await h.request('/projects/nope/tour')).status).toBe(400);
    });

    it('TC-MISC-106 POST returns 202 and reports generating', async () => {
      const res = await h.request(`/projects/${VALID_UUID}/tour`, {
        method: 'POST',
      });
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ status: 'generating' });
    });

    it('TC-MISC-107 POST is fire-and-forget — it does not await generation', async () => {
      // A real tour is 5-8 sequential model calls; holding the request open
      // would time out. The client polls GET instead.
      const before = tourGenerateCalls;
      const started = Date.now();
      await h.request(`/projects/${VALID_UUID}/tour`, { method: 'POST' });
      expect(tourGenerateCalls).toBe(before + 1);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it('TC-MISC-108 POST returns 400 for a malformed project id', async () => {
      const res = await h.request('/projects/nope/tour', { method: 'POST' });
      expect(res.status).toBe(400);
    });
  });

  // ------------------------------------------- GET /projects/:id/changes

  describe('TC-MISC-120..125 — GET changes (status envelope)', () => {
    it('TC-MISC-120 returns 200 with a ready analysis', async () => {
      analysisStatus = { status: 'ready', analysis: analysisRecord };
      const res = await h.request(`/projects/${VALID_UUID}/changes`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'ready' });
    });

    it('TC-MISC-121 returns 200 while generating', async () => {
      analysisStatus = { status: 'generating', analysis: null };
      const res = await h.request(`/projects/${VALID_UUID}/changes`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'generating', analysis: null });
    });

    it('TC-MISC-122 returns 200 with "absent" rather than 404', async () => {
      analysisStatus = { status: 'absent', analysis: null };
      const res = await h.request(`/projects/${VALID_UUID}/changes`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'absent', analysis: null });
    });

    it('TC-MISC-123 maps the record to the documented DTO', async () => {
      analysisStatus = { status: 'ready', analysis: analysisRecord };
      const body = (await h.request(`/projects/${VALID_UUID}/changes`))
        .body as {
        analysis: Record<string, unknown>;
      };
      expect(Object.keys(body.analysis).sort()).toEqual([
        'changedFiles',
        'citations',
        'commitHash',
        'commitMessage',
        'generatedAt',
        'summary',
      ]);
    });

    it('TC-MISC-124 POST returns 202 and reports generating', async () => {
      const res = await h.request(`/projects/${VALID_UUID}/changes`, {
        method: 'POST',
      });
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ status: 'generating' });
    });

    it('TC-MISC-125 returns 400 for a malformed project id', async () => {
      expect((await h.request('/projects/nope/changes')).status).toBe(400);
    });
  });

  // -------------------------------------------------------- POST /search

  describe('TC-MISC-200..214 — POST /search', () => {
    const search = (body: unknown) => h.request('/search', json(body));
    const valid = { projectId: VALID_UUID, query: 'auth', mode: 'hybrid' };

    it('TC-MISC-200 [DEFECT-010 fixed] returns ranked results as the declared 200', async () => {
      // Was the one POST route without an explicit @HttpCode, so Nest's POST
      // default (201) applied while @ApiOkResponse published 200 in the OpenAPI
      // spec and therefore in the generated web/src/api/schema.d.ts. Corrected
      // towards the spec: a search creates nothing, so 200 is also the truer
      // status, and schema.d.ts already declared it — no regeneration needed.
      const res = await search(valid);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it('TC-MISC-201 returns the documented ScoredChunkDto shape', async () => {
      const [chunk] = (await search(valid)).body as Record<string, unknown>[];
      expect(Object.keys(chunk!).sort()).toEqual([
        'chunkId',
        'content',
        'endLine',
        'path',
        'score',
        'startLine',
        'symbol',
      ]);
    });

    it('TC-MISC-202 does not leak the internal contentHash field', async () => {
      const res = await search(valid);
      expect(res.text).not.toContain('contentHash');
      expect(res.text).not.toContain('deadbeef');
    });

    it('TC-MISC-203 accepts every documented mode', async () => {
      for (const mode of ['vector', 'fts', 'trigram', 'hybrid']) {
        const res = await search({ ...valid, mode });
        expect(res.status, mode).toBe(200);
      }
    });

    it('TC-MISC-204 rejects an unknown mode', async () => {
      expect((await search({ ...valid, mode: 'semantic' })).status).toBe(400);
    });

    it('TC-MISC-205 rejects a missing mode', async () => {
      const noMode = { projectId: valid.projectId, query: valid.query };
      expect((await search(noMode)).status).toBe(400);
    });

    it('TC-MISC-206 rejects a non-UUID projectId', async () => {
      expect((await search({ ...valid, projectId: 'nope' })).status).toBe(400);
    });

    it('TC-MISC-207 rejects an empty query', async () => {
      expect((await search({ ...valid, query: '' })).status).toBe(400);
    });

    it('TC-MISC-208 rejects a missing query', async () => {
      const noQuery = { projectId: valid.projectId, mode: valid.mode };
      expect((await search(noQuery)).status).toBe(400);
    });

    it('TC-MISC-209 accepts k at both bounds', async () => {
      for (const k of [1, 50]) {
        expect((await search({ ...valid, k })).status, String(k)).toBe(200);
      }
    });

    it('TC-MISC-210 rejects k below 1 and above 50', async () => {
      for (const k of [0, -1, 51, 1000]) {
        expect((await search({ ...valid, k })).status, String(k)).toBe(400);
      }
    });

    it('TC-MISC-211 rejects a fractional k', async () => {
      expect((await search({ ...valid, k: 2.5 })).status).toBe(400);
    });

    it('TC-MISC-212 forwards k as undefined when omitted, letting the service default', async () => {
      await search(valid);
      expect(searchArgs[3]).toBeUndefined();
    });

    it('TC-MISC-213 rejects an unknown extra property', async () => {
      expect((await search({ ...valid, limit: 5 })).status).toBe(400);
    });

    it('TC-MISC-214 passes a metacharacter-laden query through untouched', async () => {
      const query = "'; DROP TABLE chunks; -- .*+?[](){}";
      await search({ ...valid, query });
      expect(searchArgs[1]).toBe(query);
    });
  });

  // ------------------------------------------------------- POST /uploads

  describe('TC-MISC-300..305 — POST /uploads', () => {
    // A successful upload streams a real file to data/uploads/<id>.zip. Track
    // and remove them — a test suite that litters the app's own data directory
    // is a test suite people learn to distrust.
    const writtenIds: string[] = [];

    /**
     * A genuine, minimal zip: the end-of-central-directory record alone
     * (PK\x05\x06 + 18 zero bytes) — a valid EMPTY archive, which is a real
     * thing and not the same question as "is it a zip?".
     *
     * Needed since the DEF-021 fix, which checks the signature after the write.
     * Note TC-MISC-304 below already sent a genuine PK\x03\x04 header with a
     * text tail and still passes: only the first four bytes are inspected.
     */
    const ZIP_BYTES = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x05, 0x06]),
      Buffer.alloc(18),
    ]);

    const upload = async (filename: string, content: Buffer | string) => {
      const form = new FormData();
      form.append('file', new Blob([content]), filename);
      const res = await h.request('/uploads', { method: 'POST', body: form });
      const uploadId = (res.body as { uploadId?: string } | undefined)
        ?.uploadId;
      if (uploadId) writtenIds.push(uploadId);
      return res;
    };

    afterAll(async () => {
      const uploadsDir = path.resolve(__dirname, '..', 'data', 'uploads');
      await Promise.all(
        writtenIds.map((id) =>
          rm(path.join(uploadsDir, `${id}.zip`), { force: true }),
        ),
      );
    });

    it('TC-MISC-300 rejects a request with no file', async () => {
      const res = await h.request('/uploads', {
        method: 'POST',
        body: new FormData(),
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/No file uploaded/);
    });

    it('TC-MISC-301 rejects a non-zip extension (SEC)', async () => {
      const res = await upload('payload.exe', 'MZ');
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/Only \.zip uploads/);
    });

    it('TC-MISC-302 rejects a double extension ending in something else', async () => {
      const res = await upload('archive.zip.exe', 'x');
      expect(res.status).toBe(400);
    });

    it('TC-MISC-303 accepts a .zip regardless of letter case', async () => {
      const res = await upload('Archive.ZIP', ZIP_BYTES);
      expect(res.status).toBe(201);
    });

    it('TC-MISC-304 returns an uploadId and a size', async () => {
      const res = await upload('repo.zip', 'PK some content');
      expect(res.status).toBe(201);
      const body = res.body as { uploadId: string; sizeBytes: number };
      expect(typeof body.sizeBytes).toBe('number');
      expect(body.uploadId).toMatch(/\S/);
    });

    it('TC-MISC-306 [DEF-021] rejects .zip-named bytes that are not a zip', async () => {
      // The fix's point: the extension is a hint, the signature is the check.
      // Before it this returned 201 and the failure surfaced much later, as a
      // failed indexing job on a project the user had already created.
      const res = await upload('repo.zip', 'this is not an archive');
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/not a zip/i);
    });

    it('TC-MISC-305 never returns the stored filesystem path (SEC)', async () => {
      const res = await upload('repo.zip', ZIP_BYTES);
      expect(res.text).not.toMatch(/\/Users\/|[A-Z]:\\|\/tmp\//);
      expect(Object.keys(res.body as object).sort()).toEqual([
        'sizeBytes',
        'uploadId',
      ]);
    });
  });

  // ------------------------------------------------------ GET /providers

  describe('TC-MISC-400..403 — GET /providers', () => {
    it('TC-MISC-400 returns provider status', async () => {
      const res = await h.request('/providers');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ embedRequestsToday: 12 });
    });

    it('TC-MISC-401 reports both provider slots', async () => {
      const body = (await h.request('/providers')).body as Record<
        string,
        unknown
      >;
      expect(body).toHaveProperty('embedding');
      expect(body).toHaveProperty('chat');
    });

    it('TC-MISC-402 never exposes an API key (SEC)', async () => {
      // The response names the models and quota, never the credentials behind
      // them — complements common/redact.ts on the error path.
      const res = await h.request('/providers');
      expect(res.text).not.toMatch(/AIza|gsk_|sk-|apiKey|api_key/i);
    });

    it('TC-MISC-403 rejects an unsupported method', async () => {
      expect((await h.request('/providers', { method: 'POST' })).status).toBe(
        404,
      );
    });
  });
});
