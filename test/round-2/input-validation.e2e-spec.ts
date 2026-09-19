import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import {
  createHarness,
  json,
  VALID_UUID,
  UNKNOWN_UUID,
  type Harness,
} from '../harness';
import { PROJECT_NAME_MAX_LENGTH } from '../../src/contracts';
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
  let cancelResult: 'canceled' | 'canceling' | 'absent' | null = null;
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
            // Mirrors the real repository contract since the DEF-022 fix:
            // 'absent' for "no such job", null for "exists but terminal". Each
            // test sets `cancelResult` to the case it is exercising.
            cancel: () => Promise.resolve(cancelResult),
            findLatest: () => Promise.resolve(null),
            findLatestForProjects: () => Promise.resolve(new Map()),
          },
        },
        {
          provide: TourService,
          useValue: {
            getTourStatus: () =>
              Promise.resolve({ status: 'absent', tour: null }),
            // The DEF-020 guard the controller now awaits. Only VALID_UUID
            // exists in this harness.
            assertProjectExists: (id: string) =>
              id === VALID_UUID
                ? Promise.resolve(undefined)
                : Promise.reject(
                    new NotFoundException(`Project ${id} not found`),
                  ),
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

    it('TC-R2-101 [DEF-019 FIXED] rejects a whitespace-only name', async () => {
      // DEF-019 (S4), found 2026-09-17, fixed 2026-09-18 — the same root cause
      // as DEF-025 on the chat DTO. `@IsNotEmpty()` passes on "   " because it
      // only rejects the empty string, so a project could be created with a
      // name that renders as a blank row in the sidebar, the library grid and
      // the command palette, unfindable by name anywhere.
      for (const name of ['   ', '\t', '\n', ' \t ']) {
        const res = await h.request(
          '/projects',
          json({ name, sourceKind: 'local_path', sourceRef: '/tmp/x' }),
        );
        expect(res.status, `expected 400 for ${JSON.stringify(name)}`).toBe(
          400,
        );
      }
    });

    it('TC-R2-103 [DEF-019] trims a name that has real content', async () => {
      // The other half of the same transform: "Demo " and "Demo" must not be
      // two differently-named projects.
      const res = await h.request(
        '/projects',
        json({
          name: '  Demo  ',
          sourceKind: 'local_path',
          sourceRef: '/tmp/x',
        }),
      );
      expect(res.status).toBe(201);
      expect(lastCreate?.name).toBe('Demo');
    });

    it('TC-R2-102 [DEF-019 FIXED] rejects an unbounded name', async () => {
      // Second half: there was no `@MaxLength`, so the only ceiling was
      // Postgres' `text` column — i.e. none that matters for a UI.
      const res = await h.request(
        '/projects',
        json({
          name: 'a'.repeat(10_000),
          sourceKind: 'local_path',
          sourceRef: '/tmp/x',
        }),
      );
      expect(res.status).toBe(400);
    });

    it('TC-R2-104 [DEF-019] accepts a name exactly at the limit', async () => {
      // Pins the boundary rather than just "long is rejected", so the limit
      // cannot drift silently.
      const res = await h.request(
        '/projects',
        json({
          name: 'a'.repeat(PROJECT_NAME_MAX_LENGTH),
          sourceKind: 'local_path',
          sourceRef: '/tmp/x',
        }),
      );
      expect(res.status).toBe(201);
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
    it('TC-R2-120 [DEF-022 FIXED] returns 404 for a job that does not exist', async () => {
      // DEF-022 (S4), found 2026-09-17, fixed 2026-09-18. `requestCancel`
      // resolved null for both "unknown id" and "already terminal", and the
      // controller mapped null to 409 "is not active" — so a client could not
      // tell a typo'd id from a race it lost. It now resolves 'absent' for the
      // first case.
      cancelResult = 'absent';
      const res = await h.request(`/jobs/${UNKNOWN_UUID}/cancel`, {
        method: 'POST',
      });
      expect(res.status).toBe(404);
    });

    it('TC-R2-123 [DEF-022] still returns 409 for a job that exists but is finished', async () => {
      // The distinction only means something if the other side still holds.
      cancelResult = null;
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

    it('TC-R2-122 [DEF-020 FIXED] rejects tour generation for a project that does not exist', async () => {
      // DEF-020 (S4), found 2026-09-17, fixed 2026-09-18. Unlike every other
      // project-scoped route, `POST /projects/:id/tour` never checked that the
      // project existed — it returned 202 and scheduled real work keyed to a
      // fabricated id.
      //
      // The sibling GET is NOT a defect and is unchanged: returning 200
      // `{status:'absent'}` in every state is the deliberate Phase 13.5
      // contract that stopped the client polling a 404 forever. Only the POST
      // was missing its guard.
      tourGenerateCalledWith = [];
      const res = await h.request(`/projects/${UNKNOWN_UUID}/tour`, {
        method: 'POST',
      });
      expect(res.status).toBe(404);
      // And nothing was scheduled, which is the point — a 404 that still
      // queued the work would be no better than the 202.
      expect(tourGenerateCalledWith).toEqual([]);
    });
  });

  describe('TC-R2-13x — uploads', () => {
    it('TC-R2-130 [DEF-021 FIXED] rejects bytes that are not a zip, whatever the filename', async () => {
      // DEF-021 (S4), found 2026-09-17, fixed 2026-09-18. The fileFilter in
      // 'src/uploads/uploads.controller.ts' can only see the *name* — multer
      // runs it before any bytes are written — so anything was accepted as long
      // as it ended in `.zip`, and the failure surfaced much later as a failed
      // indexing job on a project the user had already created. The signature
      // is now checked after the write.
      //
      // The zip-slip defences are NOT what was at issue and remain intact (see
      // `zip-extractor.spec.ts`); this is about where the failure surfaces.
      const form = new FormData();
      form.append(
        'file',
        new Blob(['this is definitely not a zip archive'], {
          type: 'application/zip',
        }),
        'payload.zip',
      );
      const res = await h.request('/uploads', { method: 'POST', body: form });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/not a zip/i);
    });

    it('TC-R2-133 [DEF-021] accepts real zip bytes', async () => {
      // A minimal but genuine empty archive: the end-of-central-directory
      // record alone, PK\x05\x06 + 18 zero bytes. Asserted because "reject
      // non-zips" is only half the fix — rejecting real ones too would be worse
      // than the defect.
      const eocd = Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x05, 0x06]),
        Buffer.alloc(18),
      ]);
      const form = new FormData();
      form.append(
        'file',
        new Blob([eocd], { type: 'application/zip' }),
        'real.zip',
      );
      const res = await h.request('/uploads', { method: 'POST', body: form });
      expect(res.status).toBe(201);
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
