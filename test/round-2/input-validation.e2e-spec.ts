import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import {
  createHarness,
  json,
  VALID_UUID,
  UNKNOWN_UUID,
  type Harness,
} from '../harness';
import { ProjectsService } from '../../src/projects/projects.service';
import { JobsService } from '../../src/jobs/jobs.service';
import { TourService } from '../../src/tour/tour.service';

/**
 * QA round 2 — TC-R2-1xx. Input validation and resource-existence gaps found by
 * black-box probing the running app on 2026-09-17.
 *
 * Each `[DEFECT ...]` case asserts **today's behaviour**, not the desired one,
 * so the reproduction survives until someone fixes it. Invert the assertion in
 * the fixing slice — the Phase 16 convention.
 *
 * The non-defect cases around them are deliberate: they hold the line that was
 * already correct, so a fix for one of these cannot quietly widen into the
 * neighbouring case.
 */

const NOW = new Date('2026-01-01T00:00:00.000Z');

const projectRow = (over: Record<string, unknown> = {}) => ({
  id: VALID_UUID,
  name: 'Demo',
  sourceKind: 'local_path',
  sourceRef: '/tmp/demo',
  workspacePath: '/tmp/demo',
  status: 'ready',
  fileCount: 1,
  chunkCount: 1,
  overview: null,
  headRevision: 'rev-1',
  createdAt: NOW,
  ...over,
});

describe('QA round 2 — input validation and existence checks', () => {
  let h: Harness;
  let lastCreate: Record<string, unknown> | undefined;
  let tourGenerateCalledWith: string[] = [];
  /**
   * A successful upload streams a real file to `data/uploads/<id>.zip` — the
   * harness fakes the database, not the disk. Tracked and removed in `afterAll`
   * so the suite leaves no litter in the gitignored data directory.
   */
  const uploadedIds: string[] = [];

  beforeAll(async () => {
    h = await createHarness({
      overrides: [
        {
          provide: ProjectsService,
          useValue: {
            create: (dto: Record<string, unknown>) => {
              lastCreate = dto;
              return Promise.resolve(projectRow({ name: dto.name as string }));
            },
            findAll: () => Promise.resolve([]),
          },
        },
        {
          provide: JobsService,
          useValue: {
            // Mirrors the real repository contract: `requestCancel` resolves
            // null both for "no such job" and "job already terminal". The
            // controller cannot tell them apart — that is DEF-022.
            cancel: () => Promise.resolve(null),
            findLatest: () => Promise.resolve(null),
            findLatestForProjects: () => Promise.resolve(new Map()),
          },
        },
        {
          provide: TourService,
          useValue: {
            getTourStatus: () =>
              Promise.resolve({ status: 'absent', tour: null }),
            generate: (id: string) => {
              tourGenerateCalledWith.push(id);
              return Promise.resolve(undefined);
            },
          },
        },
      ],
    });
  });

  afterAll(async () => {
    const uploadsDir = path.resolve(__dirname, '..', '..', 'data', 'uploads');
    await Promise.all(
      uploadedIds.map((id) =>
        rm(path.join(uploadsDir, `${id}.zip`), { force: true }),
      ),
    );
    await h.close();
  });

  describe('TC-R2-10x — POST /projects name handling', () => {
    it('TC-R2-100 rejects an empty name', async () => {
      const res = await h.request(
        '/projects',
        json({ name: '', sourceKind: 'local_path', sourceRef: '/tmp/x' }),
      );
      expect(res.status).toBe(400);
    });

    it('TC-R2-101 [DEFECT DEF-019] accepts a whitespace-only name', async () => {
      // DEF-019 (S4). `@IsNotEmpty()` passes on "   " because it only rejects
      // the empty string. The project then renders as a nameless row in the
      // sidebar and the library grid, and is unselectable by name in the
      // command palette. A `@Transform(trim)` before the check would close it.
      //
      // INVERT THIS when DEF-019 is fixed: expect 400.
      const res = await h.request(
        '/projects',
        json({ name: '   ', sourceKind: 'local_path', sourceRef: '/tmp/x' }),
      );
      expect(res.status).toBe(201);
      expect(lastCreate?.name).toBe('   ');
    });

    it('TC-R2-102 [DEFECT DEF-019] accepts an unbounded 10,000-character name', async () => {
      // Same defect, second half: there is no `@MaxLength` on the field, so the
      // only ceiling is Postgres' `text` column (i.e. none that matters).
      //
      // INVERT THIS when DEF-019 is fixed: expect 400.
      const res = await h.request(
        '/projects',
        json({
          name: 'a'.repeat(10_000),
          sourceKind: 'local_path',
          sourceRef: '/tmp/x',
        }),
      );
      expect(res.status).toBe(201);
      expect(String(lastCreate?.name)).toHaveLength(10_000);
    });
  });

  describe('TC-R2-11x — POST /projects sourceRef handling', () => {
    it('TC-R2-110 [DEF-018] sourceRef shape is NOT a DTO-layer rule', async () => {
      // DEF-018 was fixed on 2026-09-18, but not here — the rule is conditional
      // on `sourceKind`, so it lives in `ProjectsService.create` beside the
      // pre-existing `zip_upload` check. This spec stubs that service wholesale
      // (see the overrides above), so it is structurally incapable of seeing
      // it: the relative path below still reaches the fake and still returns
      // 201.
      //
      // Kept, rather than deleted, precisely to record that blind spot. The
      // real assertions are TC-R2-201..204 in
      // `test/round-2/project-create-validation.spec.ts`, which run the real
      // service. A reader who finds only this test and concludes the value is
      // unvalidated would be wrong, which is what the pointer is for.
      const res = await h.request(
        '/projects',
        json({
          name: 'rel',
          sourceKind: 'local_path',
          sourceRef: './fixtures/tiny-repo',
        }),
      );
      expect(res.status).toBe(201);
      expect(lastCreate?.sourceRef).toBe('./fixtures/tiny-repo');
    });

    it('TC-R2-111 [DEF-018] the DTO still rejects an empty sourceRef', async () => {
      // What this layer genuinely owns: presence and type. Everything about the
      // *shape* of the path is the service's, per TC-R2-110's note.
      const res = await h.request(
        '/projects',
        json({ name: 'ghost', sourceKind: 'local_path', sourceRef: '' }),
      );
      expect(res.status).toBe(400);
    });

    it('TC-R2-112 rejects a bogus zip_upload ref at create time (the correct behaviour)', async () => {
      // Kept as the counter-example to TC-R2-110/111: this is the eager
      // validation the other two source kinds lack. Note it is enforced by the
      // real ProjectsService, so it holds even with the service faked above
      // only for `create` — hence asserting through the DTO layer instead.
      const res = await h.request(
        '/projects',
        json({ name: 'zip', sourceKind: 'zip_upload', sourceRef: '' }),
      );
      expect(res.status).toBe(400);
    });

    it('TC-R2-113 still rejects an unknown sourceKind', async () => {
      const res = await h.request(
        '/projects',
        json({ name: 'x', sourceKind: 'ftp', sourceRef: '/tmp/x' }),
      );
      expect(res.status).toBe(400);
    });

    it('TC-R2-114 still rejects an unknown extra property', async () => {
      const res = await h.request(
        '/projects',
        json({
          name: 'x',
          sourceKind: 'local_path',
          sourceRef: '/tmp/x',
          isAdmin: true,
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe('TC-R2-12x — resource existence', () => {
    it('TC-R2-120 [DEFECT DEF-022] returns 409, not 404, for a job that does not exist', async () => {
      // DEF-022 (S4). `JobsService.cancel` resolves null for both "unknown id"
      // and "already terminal", and the controller maps null to
      // `ConflictException("Job … is not active")`. A client cannot distinguish
      // a typo'd id from a race it lost.
      //
      // INVERT THIS when DEF-022 is fixed: expect 404 for an unknown id and
      // keep 409 for a known-but-terminal one.
      const res = await h.request(`/jobs/${UNKNOWN_UUID}/cancel`, {
        method: 'POST',
      });
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('is not active');
    });

    it('TC-R2-121 still rejects a malformed job id with 400', async () => {
      const res = await h.request('/jobs/not-a-uuid/cancel', {
        method: 'POST',
      });
      expect(res.status).toBe(400);
    });

    it('TC-R2-122 [DEFECT DEF-020] accepts tour generation for a project that does not exist', async () => {
      // DEF-020 (S4). Unlike every other project-scoped route, `POST
      // /projects/:id/tour` never checks that the project exists — it returns
      // 202 and schedules real work keyed to a fabricated id.
      //
      // Note the sibling GET is NOT a defect: returning 200 `{status:'absent'}`
      // in every state is the deliberate Phase 13.5 contract that stopped the
      // client polling a 404 forever. Only the POST is missing its guard.
      //
      // INVERT THIS when DEF-020 is fixed: expect 404.
      tourGenerateCalledWith = [];
      const res = await h.request(`/projects/${UNKNOWN_UUID}/tour`, {
        method: 'POST',
      });
      expect(res.status).toBe(202);
      expect(tourGenerateCalledWith).toContain(UNKNOWN_UUID);
    });
  });

  describe('TC-R2-13x — uploads', () => {
    it('TC-R2-130 [DEFECT DEF-021] accepts any bytes so long as the filename ends in .zip', async () => {
      // DEF-021 (S4). The fileFilter in 'src/uploads/uploads.controller.ts' tests
      // `originalname.endsWith('.zip')` and nothing else — no magic-number
      // check (`PK\x03\x04`), no size floor. Arbitrary content is written to
      // `data/uploads/<uploadId>.zip` and only rejected later, at materialize
      // time, as a failed indexing job.
      //
      // The zip-slip defences are NOT what is at issue here and remain intact
      // (see `zip-extractor.spec.ts`); this is about where the failure surfaces.
      //
      // INVERT THIS when DEF-021 is fixed: expect 400.
      const form = new FormData();
      form.append(
        'file',
        new Blob(['this is definitely not a zip archive'], {
          type: 'application/zip',
        }),
        'payload.zip',
      );
      const res = await h.request('/uploads', { method: 'POST', body: form });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('uploadId');
      uploadedIds.push((res.body as { uploadId: string }).uploadId);
    });

    it('TC-R2-131 still rejects a non-.zip filename', async () => {
      const form = new FormData();
      form.append('file', new Blob(['hello']), 'notes.txt');
      const res = await h.request('/uploads', { method: 'POST', body: form });
      expect(res.status).toBe(400);
    });

    it('TC-R2-132 still rejects a request with no file part', async () => {
      const res = await h.request('/uploads', {
        method: 'POST',
        body: new FormData(),
      });
      expect(res.status).toBe(400);
    });
  });
});
