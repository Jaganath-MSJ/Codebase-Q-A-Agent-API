import { describe, it, expect, vi } from 'vitest';
import { ChangeAnalysisService } from './change-analysis.service';
import type { ProjectsRepository } from '../db/repositories/projects.repository';
import type { ChunksRepository } from '../db/repositories/chunks.repository';
import type { RetrievalService } from '../retrieval/retrieval.service';
import type { ChatProvider } from '../llm/chat-provider.interface';

const REV = 'rev-abc';

function build(project: Record<string, unknown> | null) {
  const projectsRepository = {
    findById: vi.fn().mockResolvedValue(project),
  } as unknown as ProjectsRepository;
  return new ChangeAnalysisService(
    projectsRepository,
    {} as ChunksRepository,
    {} as RetrievalService,
    {} as ChatProvider,
  );
}

describe('ChangeAnalysisService on-demand generation', () => {
  it('triggers for a git project with no analysis for the current revision', async () => {
    const svc = build({
      id: 'p1',
      status: 'ready',
      headRevision: REV,
      sourceKind: 'git_url',
      changeAnalysis: null,
    });
    const gen = vi.spyOn(svc, 'generate').mockResolvedValue(undefined);
    expect((await svc.getAnalysisStatus('p1')).analysis).toBeNull();
    expect(gen).toHaveBeenCalledWith('p1');
  });

  it('does NOT trigger for a non-git project (change analysis never applies)', async () => {
    const svc = build({
      id: 'p1',
      status: 'ready',
      headRevision: REV,
      sourceKind: 'local_path',
      changeAnalysis: null,
    });
    const gen = vi.spyOn(svc, 'generate').mockResolvedValue(undefined);
    await svc.getAnalysisStatus('p1');
    expect(gen).not.toHaveBeenCalled();
  });

  it('does NOT trigger when an up-to-date analysis exists', async () => {
    const analysis = {
      revision: REV,
      commitHash: 'h',
      commitMessage: 'm',
      changedFiles: [],
      summary: '',
      citations: [],
      generatedAt: 'x',
    };
    const svc = build({
      id: 'p1',
      status: 'ready',
      headRevision: REV,
      sourceKind: 'git_url',
      changeAnalysis: analysis,
    });
    const gen = vi.spyOn(svc, 'generate').mockResolvedValue(undefined);
    expect((await svc.getAnalysisStatus('p1')).analysis).toEqual(analysis);
    expect(gen).not.toHaveBeenCalled();
  });

  it('dedupes concurrent polls into a single in-flight generation', async () => {
    const svc = build({
      id: 'p1',
      status: 'ready',
      headRevision: REV,
      sourceKind: 'git_private',
      changeAnalysis: null,
    });
    let resolve!: () => void;
    const gen = vi
      .spyOn(svc, 'generate')
      .mockReturnValue(new Promise<void>((r) => (resolve = () => r())));
    await svc.getAnalysisStatus('p1');
    await svc.getAnalysisStatus('p1');
    expect(gen).toHaveBeenCalledOnce();
    resolve();
  });
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('ChangeAnalysisService status envelope', () => {
  it("reports 'ready' with the analysis when a fresh one exists", async () => {
    const analysis = {
      revision: REV,
      commitHash: 'h',
      commitMessage: 'm',
      changedFiles: [],
      summary: '',
      citations: [],
      generatedAt: 'x',
    };
    const svc = build({
      id: 'p1',
      status: 'ready',
      headRevision: REV,
      sourceKind: 'git_url',
      changeAnalysis: analysis,
    });
    expect(await svc.getAnalysisStatus('p1')).toEqual({
      analysis,
      status: 'ready',
    });
  });

  it("reports 'absent' for a non-git project (analysis never applies) without triggering", async () => {
    const svc = build({
      id: 'p1',
      status: 'ready',
      headRevision: REV,
      sourceKind: 'local_path',
      changeAnalysis: null,
    });
    const gen = vi.spyOn(svc, 'generate').mockResolvedValue(undefined);
    expect(await svc.getAnalysisStatus('p1')).toEqual({
      analysis: null,
      status: 'absent',
    });
    expect(gen).not.toHaveBeenCalled();
  });

  it("reports 'generating' on the kickoff poll, then 'absent' once the attempt produced nothing", async () => {
    const svc = build({
      id: 'p1',
      status: 'ready',
      headRevision: REV,
      sourceKind: 'git_url',
      changeAnalysis: null,
    });
    const gen = vi.spyOn(svc, 'generate').mockResolvedValue(undefined);
    expect((await svc.getAnalysisStatus('p1')).status).toBe('generating');
    await flush();
    expect(await svc.getAnalysisStatus('p1')).toEqual({
      analysis: null,
      status: 'absent',
    });
    expect(gen).toHaveBeenCalledOnce();
  });
});
