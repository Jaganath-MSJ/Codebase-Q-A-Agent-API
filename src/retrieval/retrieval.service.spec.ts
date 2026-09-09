import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { RetrievalService } from './retrieval.service';
import type { ProjectsRepository } from '../db/repositories/projects.repository';
import type { VectorRetriever } from './vector.retriever';
import type { FtsRetriever } from './fts.retriever';
import type { TrigramRetriever } from './trigram.retriever';
import type { HybridRetriever } from './hybrid.retriever';
import type { ReferencesRetriever } from './references.retriever';
import type { EmbeddingProvider } from '../embeddings/embedding-provider.interface';

const ACTIVE = 'local:nomic-ai/nomic-embed-text-v1.5';

function build(projectOverrides: Record<string, unknown> = {}) {
  const project = { id: 'p1', name: 'P1', status: 'ready', embeddingModel: ACTIVE, ...projectOverrides };
  const projectsRepository = { findById: vi.fn().mockResolvedValue(project) } as unknown as ProjectsRepository;
  const hybridRetriever = { search: vi.fn().mockResolvedValue([]) } as unknown as HybridRetriever;
  const vectorRetriever = { search: vi.fn().mockResolvedValue([]) } as unknown as VectorRetriever;
  const embedQuery = vi.fn().mockResolvedValue([0.1, 0.2]);
  const embeddingProvider = { id: ACTIVE, embedQuery } as unknown as EmbeddingProvider;
  const svc = new RetrievalService(
    projectsRepository,
    vectorRetriever,
    {} as FtsRetriever,
    {} as TrigramRetriever,
    hybridRetriever,
    {} as ReferencesRetriever,
    embeddingProvider,
  );
  return { svc, hybridRetriever, vectorRetriever, embedQuery };
}

describe('RetrievalService.searchWithQueryVector (Phase 12.11)', () => {
  it('runs hybrid search with the supplied vector and does NOT re-embed', async () => {
    const { svc, hybridRetriever, embedQuery } = build();
    const vec = [0.5, 0.6, 0.7];
    await svc.searchWithQueryVector('p1', 'q', vec, 10);
    expect(hybridRetriever.search).toHaveBeenCalledWith('p1', 'q', vec, 10);
    expect(embedQuery).not.toHaveBeenCalled();
  });

  it('throws on an embedding-model mismatch (caught/isolated by the fan-out caller)', async () => {
    const { svc } = build({ embeddingModel: 'gemini:other' });
    await expect(svc.searchWithQueryVector('p1', 'q', [0.1], 10)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('embedQuery delegates to the active provider exactly once', async () => {
    const { svc, embedQuery } = build();
    await svc.embedQuery('hello');
    expect(embedQuery).toHaveBeenCalledOnce();
    expect(embedQuery).toHaveBeenCalledWith('hello');
  });
});
