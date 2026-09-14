import { describe, it, expect, vi } from 'vitest';
import { TourService } from './tour.service';
import type { ProjectsRepository } from '../db/repositories/projects.repository';
import type { ChunksRepository } from '../db/repositories/chunks.repository';
import type { ChatProvider } from '../llm/chat-provider.interface';

const REV = 'rev-abc';

function build(project: Record<string, unknown> | null) {
  const projectsRepository = {
    findById: vi.fn().mockResolvedValue(project),
  } as unknown as ProjectsRepository;
  return new TourService(
    projectsRepository,
    {} as ChunksRepository,
    {} as ChatProvider,
  );
}

describe('TourService on-demand generation (Phase 12.12)', () => {
  it('triggers generation when no tour exists for the current revision', async () => {
    const svc = build({
      id: 'p1',
      status: 'ready',
      headRevision: REV,
      tour: null,
    });
    const gen = vi.spyOn(svc, 'generate').mockResolvedValue(undefined);
    expect((await svc.getTourStatus('p1')).tour).toBeNull();
    expect(gen).toHaveBeenCalledWith('p1');
  });

  it('does NOT trigger when an up-to-date tour already exists', async () => {
    const tour = { revision: REV, summary: '', sections: [], generatedAt: 'x' };
    const svc = build({ id: 'p1', status: 'ready', headRevision: REV, tour });
    const gen = vi.spyOn(svc, 'generate').mockResolvedValue(undefined);
    expect((await svc.getTourStatus('p1')).tour).toEqual(tour);
    expect(gen).not.toHaveBeenCalled();
  });

  it('regenerates a stale tour but returns the stale one meanwhile', async () => {
    const stale = {
      revision: 'old',
      summary: '',
      sections: [],
      generatedAt: 'x',
    };
    const svc = build({
      id: 'p1',
      status: 'ready',
      headRevision: REV,
      tour: stale,
    });
    const gen = vi.spyOn(svc, 'generate').mockResolvedValue(undefined);
    expect((await svc.getTourStatus('p1')).tour).toEqual(stale);
    expect(gen).toHaveBeenCalledOnce();
  });

  it('dedupes concurrent polls into a single in-flight generation', async () => {
    const svc = build({
      id: 'p1',
      status: 'ready',
      headRevision: REV,
      tour: null,
    });
    let resolve!: () => void;
    const gen = vi
      .spyOn(svc, 'generate')
      .mockReturnValue(new Promise<void>((r) => (resolve = () => r())));
    await svc.getTourStatus('p1');
    await svc.getTourStatus('p1'); // still in-flight → no second call
    expect(gen).toHaveBeenCalledOnce();
    resolve();
  });

  it('does not trigger for a project that is not ready', async () => {
    const svc = build({
      id: 'p1',
      status: 'indexing',
      headRevision: REV,
      tour: null,
    });
    const gen = vi.spyOn(svc, 'generate').mockResolvedValue(undefined);
    await svc.getTourStatus('p1');
    expect(gen).not.toHaveBeenCalled();
  });
});

// Flush the microtasks so ensureGenerating's generate().finally() (which records
// the attempt) has run before the next assertion.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('TourService status envelope (Phase 13.5)', () => {
  it("reports 'ready' with the tour when a fresh one exists", async () => {
    const tour = { revision: REV, summary: '', sections: [], generatedAt: 'x' };
    const svc = build({ id: 'p1', status: 'ready', headRevision: REV, tour });
    expect(await svc.getTourStatus('p1')).toEqual({ tour, status: 'ready' });
  });

  it("reports 'generating' on the poll that kicks off generation", async () => {
    const svc = build({
      id: 'p1',
      status: 'ready',
      headRevision: REV,
      tour: null,
    });
    vi.spyOn(svc, 'generate').mockReturnValue(new Promise<void>(() => {})); // never resolves
    expect(await svc.getTourStatus('p1')).toEqual({
      tour: null,
      status: 'generating',
    });
  });

  it("reports 'absent' once an attempt for this revision produced no tour (stops the poll)", async () => {
    // generate resolves without the project ever gaining a tour (no chunks, empty
    // sections) — the second poll must not re-trigger, and must say 'absent'.
    const svc = build({
      id: 'p1',
      status: 'ready',
      headRevision: REV,
      tour: null,
    });
    const gen = vi.spyOn(svc, 'generate').mockResolvedValue(undefined);
    expect((await svc.getTourStatus('p1')).status).toBe('generating');
    await flush();
    expect(await svc.getTourStatus('p1')).toEqual({
      tour: null,
      status: 'absent',
    });
    expect(gen).toHaveBeenCalledOnce(); // not re-triggered
  });

  it("reports 'absent' for a ready project with no headRevision (never indexed)", async () => {
    const svc = build({
      id: 'p1',
      status: 'ready',
      headRevision: null,
      tour: null,
    });
    const gen = vi.spyOn(svc, 'generate').mockResolvedValue(undefined);
    expect(await svc.getTourStatus('p1')).toEqual({
      tour: null,
      status: 'absent',
    });
    expect(gen).not.toHaveBeenCalled();
  });

  it('re-attempts after a new revision even if the prior one produced nothing', async () => {
    const project = {
      id: 'p1',
      status: 'ready',
      headRevision: REV,
      tour: null,
    };
    const projectsRepository = {
      findById: vi.fn().mockResolvedValue(project),
    } as unknown as ProjectsRepository;
    const svc = new TourService(
      projectsRepository,
      {} as ChunksRepository,
      {} as ChatProvider,
    );
    const gen = vi.spyOn(svc, 'generate').mockResolvedValue(undefined);

    expect((await svc.getTourStatus('p1')).status).toBe('generating');
    await flush();
    expect((await svc.getTourStatus('p1')).status).toBe('absent');

    project.headRevision = 'rev-def'; // a re-index moved the revision
    expect((await svc.getTourStatus('p1')).status).toBe('generating');
    expect(gen).toHaveBeenCalledTimes(2);
  });
});
