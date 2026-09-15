import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createHarness,
  UNKNOWN_UUID,
  VALID_UUID,
  type Harness,
} from './harness';
import { JobsService } from '../src/jobs/jobs.service';
import { EventBusService } from '../src/events/event-bus.service';

/**
 * QA pass — TC-SSE-*.
 *
 * `GET /projects/:projectId/events` — the indexing progress stream, and the
 * second of the two SSE endpoints in the system (the first is the chat stream,
 * covered in `chat.e2e-spec.ts`).
 *
 * This one is harder to test than the chat stream and easy to skip for that
 * reason: it is an **infinite** observable (a 15s heartbeat keeps it open
 * forever), so a naive `await response.text()` hangs until the test times out.
 * Every test here reads a bounded number of frames from the body reader and
 * then aborts.
 *
 * What matters about this endpoint:
 *   - it sends a `snapshot` immediately on connect, so a client that attaches
 *     mid-job sees current state rather than waiting for the next change (the
 *     bus is a hot Subject — see TC-EVT-012);
 *   - it is filtered to one project;
 *   - it is not gzipped, for the same reason the chat stream is not.
 */

const NOW = new Date('2026-01-01T00:00:00.000Z');

const jobRow = (over: Record<string, unknown> = {}) => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId: VALID_UUID,
  status: 'running',
  phase: 'chunking',
  trigger: 'initial',
  attempt: 0,
  filesTotal: 10,
  filesDone: 3,
  filesSkipped: 0,
  skipReasons: {},
  chunksTotal: 0,
  chunksEmbedded: 0,
  embedRequests: 0,
  currentPath: 'src/a.ts',
  cancelRequested: false,
  errorMessage: null,
  startedAt: NOW,
  finishedAt: null,
  createdAt: NOW,
  ...over,
});

interface Frame {
  type: string;
  data: unknown;
}

/**
 * Opens the stream and resolves once `want` frames have arrived (or the
 * timeout elapses), then aborts. Returns whatever was received.
 */
async function readFrames(
  url: string,
  want: number,
  timeoutMs = 3000,
): Promise<{ frames: Frame[]; headers: Headers; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const response = await fetch(url, { signal: controller.signal });
  const frames: Frame[] = [];

  if (!response.body || response.status !== 200) {
    clearTimeout(timer);
    controller.abort();
    return { frames, headers: response.headers, status: response.status };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (frames.length < want) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split = buffer.indexOf('\n\n');
      while (split !== -1) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const type = /^event: (.+)$/m.exec(block)?.[1] ?? '';
        const raw = /^data: (.*)$/m.exec(block)?.[1] ?? '';
        let data: unknown = raw;
        try {
          data = JSON.parse(raw);
        } catch {
          /* heartbeat sends an empty payload */
        }
        if (type) frames.push({ type, data });
        split = buffer.indexOf('\n\n');
      }
    }
  } catch {
    /* aborted — whatever arrived is the result */
  } finally {
    clearTimeout(timer);
    controller.abort();
  }

  return { frames, headers: response.headers, status: response.status };
}

describe('Indexing progress SSE — GET /projects/:projectId/events', () => {
  let h: Harness;
  let eventBus: EventBusService;
  let currentJob: Record<string, unknown> | undefined;

  beforeAll(async () => {
    currentJob = jobRow();
    h = await createHarness({
      overrides: [
        {
          provide: JobsService,
          useValue: {
            findLatest: (projectId: string) =>
              Promise.resolve(
                projectId === VALID_UUID ? currentJob : undefined,
              ),
          },
        },
      ],
    });
    eventBus = h.app.get(EventBusService);
  });

  afterAll(async () => {
    await h.close();
  });

  const streamUrl = (id: string) => `${h.url}/projects/${id}/events`;

  describe('TC-SSE-001..004 — connection', () => {
    it('TC-SSE-001 responds as text/event-stream', async () => {
      const { headers, status } = await readFrames(streamUrl(VALID_UUID), 1);
      expect(status).toBe(200);
      expect(headers.get('content-type')).toMatch(/text\/event-stream/);
    });

    it('TC-SSE-002 is NOT compressed', async () => {
      // Same reasoning as the chat stream: gzip buffers, which would defeat
      // live progress. TC-CHAT-230b already proves compression is installed
      // and active on this app, so this is a real assertion, not a vacuous one.
      const { headers } = await readFrames(streamUrl(VALID_UUID), 1);
      expect(headers.get('content-encoding')).toBeNull();
    });

    it('TC-SSE-003 returns 400 for a malformed project id', async () => {
      const res = await fetch(`${h.url}/projects/not-a-uuid/events`);
      expect(res.status).toBe(400);
      await res.body?.cancel();
    });

    it('TC-SSE-004 sets no-cache so a proxy cannot replay a stale stream', async () => {
      const { headers } = await readFrames(streamUrl(VALID_UUID), 1);
      expect(headers.get('cache-control')).toMatch(/no-cache/);
    });
  });

  describe('TC-SSE-010..014 — the snapshot frame', () => {
    it('TC-SSE-010 emits a snapshot immediately on connect', async () => {
      // The event bus is a hot Subject (TC-EVT-012): anything emitted before a
      // client attaches is gone. The snapshot is what stops a client that
      // connects mid-job from seeing nothing until the next progress tick.
      const { frames } = await readFrames(streamUrl(VALID_UUID), 1);
      expect(frames[0]!.type).toBe('snapshot');
    });

    it('TC-SSE-011 carries the current job in the snapshot', async () => {
      const { frames } = await readFrames(streamUrl(VALID_UUID), 1);
      const data = frames[0]!.data as { job: Record<string, unknown> | null };
      expect(data.job).toMatchObject({
        status: 'running',
        phase: 'chunking',
        filesDone: 3,
      });
    });

    it('TC-SSE-012 sends job: null when the project has never been indexed', async () => {
      // Distinct from a 404 — the stream still opens, so the client can keep
      // listening for the first job rather than reconnecting.
      const { frames, status } = await readFrames(streamUrl(UNKNOWN_UUID), 1);
      expect(status).toBe(200);
      expect(frames[0]!.type).toBe('snapshot');
      expect((frames[0]!.data as { job: unknown }).job).toBeNull();
    });

    it('TC-SSE-013 serialises the job through the same DTO as the REST route', async () => {
      const { frames } = await readFrames(streamUrl(VALID_UUID), 1);
      const job = (frames[0]!.data as { job: Record<string, unknown> }).job;
      expect(job.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(job.finishedAt).toBeNull();
    });

    it('TC-SSE-014 never leaks a workspace path into the frame (INV-2)', async () => {
      const { frames } = await readFrames(streamUrl(VALID_UUID), 1);
      const text = JSON.stringify(frames[0]!.data);
      expect(text).not.toMatch(/\/Users\/|workspacePath|sourceRef/);
    });
  });

  describe('TC-SSE-020..022 — live progress', () => {
    it('TC-SSE-020 emits a progress frame when the bus fires for this project', async () => {
      const controller = new AbortController();
      const response = await fetch(streamUrl(VALID_UUID), {
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Drain the snapshot first, then emit — the controller applies
      // auditTime(250), so allow for that before reading again.
      const readSome = async () => {
        const { value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: true });
      };
      await readSome();

      setTimeout(() => {
        eventBus.emit({
          type: 'job.progress',
          projectId: VALID_UUID,
          jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        });
      }, 20);

      const deadline = Date.now() + 3000;
      while (!buffer.includes('event: progress') && Date.now() < deadline) {
        await readSome();
      }
      controller.abort();

      expect(buffer).toContain('event: progress');
    });

    it('TC-SSE-021 reports "done" rather than "progress" once the job is terminal', async () => {
      currentJob = jobRow({ status: 'succeeded', finishedAt: NOW });
      const controller = new AbortController();
      const response = await fetch(streamUrl(VALID_UUID), {
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const readSome = async () => {
        const { value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: true });
      };
      await readSome();

      setTimeout(() => {
        eventBus.emit({
          type: 'job.completed',
          projectId: VALID_UUID,
          jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        });
      }, 20);

      const deadline = Date.now() + 3000;
      while (!buffer.includes('event: done') && Date.now() < deadline) {
        await readSome();
      }
      controller.abort();
      currentJob = jobRow();

      expect(buffer).toContain('event: done');
    });

    it('TC-SSE-022 ignores events belonging to a different project', async () => {
      const controller = new AbortController();
      const response = await fetch(streamUrl(VALID_UUID), {
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Read until the snapshot has actually landed. A single read() can
      // return a partial chunk (observed: just the frame's trailing newline),
      // which would make the "no progress frame" assertion below pass simply
      // because nothing had been read yet.
      const deadline = Date.now() + 3000;
      while (!buffer.includes('event: snapshot') && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: true });
      }
      expect(buffer).toContain('event: snapshot'); // precondition, not the point

      // An event for a DIFFERENT project must not produce a frame here.
      eventBus.emit({
        type: 'job.progress',
        projectId: UNKNOWN_UUID,
        jobId: 'other-job',
      });
      await new Promise((r) => setTimeout(r, 500)); // past auditTime(250)
      controller.abort();

      expect(buffer).not.toContain('event: progress');
    });
  });
});
