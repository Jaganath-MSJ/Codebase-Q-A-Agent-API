import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import { EMBEDDING_PROVIDER_TOKEN } from '../embeddings/embeddings.module';
import type { EmbeddingProvider } from '../embeddings/embedding-provider.interface';
import { VectorRetriever, ScoredChunk } from './vector.retriever';
import { FtsRetriever } from './fts.retriever';
import { TrigramRetriever } from './trigram.retriever';
import { HybridRetriever } from './hybrid.retriever';
import { extractIdentifierTokens } from './identifiers';

export type RetrievalMode = 'vector' | 'fts' | 'trigram' | 'hybrid';

@Injectable()
export class RetrievalService {
  constructor(
    private readonly projectsRepository: ProjectsRepository,
    private readonly vectorRetriever: VectorRetriever,
    private readonly ftsRetriever: FtsRetriever,
    private readonly trigramRetriever: TrigramRetriever,
    private readonly hybridRetriever: HybridRetriever,
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

    if (mode === 'trigram') {
      // Trigram similarity against a whole prose question is diluted by every
      // filler word's trigrams — same failure shape as FTS's raw-AND bug from
      // 5.2. Only meaningful against the identifier itself, so an
      // identifier-free question correctly gets nothing rather than noise.
      const tokens = extractIdentifierTokens(query);
      if (tokens.length === 0) return [];
      return this.trigramRetriever.search(projectId, tokens.join(' '), limit);
    }

    // vector and hybrid both need a query embedding.
    if (project.embeddingModel !== this.embeddingProvider.id) {
      throw new BadRequestException(
        `Project '${project.name}' was indexed with embedding model '${project.embeddingModel}', ` +
          `but the active provider is '${this.embeddingProvider.id}'. This project needs re-indexing.`,
      );
    }

    const queryVector = await this.embeddingProvider.embedQuery(query);

    if (mode === 'hybrid') {
      return this.hybridRetriever.search(projectId, query, queryVector, limit);
    }

    return this.vectorRetriever.search(projectId, queryVector, limit);
  }
}
