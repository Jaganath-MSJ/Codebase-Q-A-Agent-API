import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import { EMBEDDING_PROVIDER_TOKEN } from '../embeddings/embeddings.module';
import type { EmbeddingProvider } from '../embeddings/embedding-provider.interface';
import { VectorRetriever, ScoredChunk } from './vector.retriever';
import { FtsRetriever } from './fts.retriever';

export type RetrievalMode = 'vector' | 'fts';

@Injectable()
export class RetrievalService {
  constructor(
    private readonly projectsRepository: ProjectsRepository,
    private readonly vectorRetriever: VectorRetriever,
    private readonly ftsRetriever: FtsRetriever,
    @Inject(EMBEDDING_PROVIDER_TOKEN) private readonly embeddingProvider: EmbeddingProvider,
  ) {}

  async search(
    projectId: string,
    query: string,
    mode: RetrievalMode,
    limit = 20,
  ): Promise<ScoredChunk[]> {
    const project = await this.projectsRepository.findById(projectId);
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    if (project.status !== 'ready') {
      throw new BadRequestException(
        `Project '${project.name}' is not ready for search (status: ${project.status}). Index it first.`,
      );
    }

    if (mode === 'fts') {
      return this.ftsRetriever.search(projectId, query, limit);
    }

    if (project.embeddingModel !== this.embeddingProvider.id) {
      throw new BadRequestException(
        `Project '${project.name}' was indexed with embedding model '${project.embeddingModel}', ` +
          `but the active provider is '${this.embeddingProvider.id}'. This project needs re-indexing.`,
      );
    }

    const queryVector = await this.embeddingProvider.embedQuery(query);
    return this.vectorRetriever.search(projectId, queryVector, limit);
  }
}
