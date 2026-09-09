import { describe, it, expect, vi } from 'vitest';
import { TourService } from './tour.service';
import type { ProjectsRepository } from '../db/repositories/projects.repository';
import type { ChunksRepository } from '../db/repositories/chunks.repository';
import type { ChatProvider } from '../llm/chat-provider.interface';

const REV = 'rev-abc';

function build(project: Record<string, unknown> | null) {
  const projectsRepository = { findById: vi.fn().mockResolvedValue(project) } as unknown as ProjectsRepository;
  return new TourService(projectsRepository, {} as ChunksRepository, {} as ChatProvider);
}

describe('TourService on-demand generation (Phase 12.12)', () => {
  it('triggers generation when no tour exists for the current revision', async () => {
    const svc = build({ id: 'p1', status: 'ready', headRevision: REV, tour: null });
    const gen = vi.spyOn(svc, 'generate').mockResolvedValue(undefined);
    expect(await svc.getTour('p1')).toBeNull();
    expect(gen).toHaveBeenCalledWith('p1');
  });

  it('does NOT trigger when an up-to-date tour already exists', async () => {
    const tour = { revision: REV, summary: '', sections: [], generatedAt: 'x' };
    const svc = build({ id: 'p1', status: 'ready', headRevision: REV, tour });
    const gen = vi.spyOn(svc, 'generate').mockResolvedValue(undefined);
    expect(await svc.getTour('p1')).toEqual(tour);
    expect(gen).not.toHaveBeenCalled();
  });

  it('regenerates a stale tour but returns the stale one meanwhile', async () => {
    const stale = { revision: 'old', summary: '', sections: [], generatedAt: 'x' };
    const svc = build({ id: 'p1', status: 'ready', headRevision: REV, tour: stale });
    const gen = vi.spyOn(svc, 'generate').mockResolvedValue(undefined);
    expect(await svc.getTour('p1')).toEqual(stale);
    expect(gen).toHaveBeenCalledOnce();
  });

  it('dedupes concurrent polls into a single in-flight generation', async () => {
    const svc = build({ id: 'p1', status: 'ready', headRevision: REV, tour: null });
    let resolve!: () => void;
    const gen = vi.spyOn(svc, 'generate').mockReturnValue(new Promise<void>((r) => (resolve = () => r())));
    await svc.getTour('p1');
    await svc.getTour('p1'); // still in-flight → no second call
    expect(gen).toHaveBeenCalledOnce();
    resolve();
  });

  it('does not trigger for a project that is not ready', async () => {
    const svc = build({ id: 'p1', status: 'indexing', headRevision: REV, tour: null });
    const gen = vi.spyOn(svc, 'generate').mockResolvedValue(undefined);
    await svc.getTour('p1');
    expect(gen).not.toHaveBeenCalled();
  });
});
