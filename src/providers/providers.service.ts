import { Inject, Injectable } from '@nestjs/common';
import { EMBEDDING_PROVIDER_TOKEN } from '../embeddings/embeddings.module';
import type { EmbeddingProvider } from '../embeddings/embedding-provider.interface';
import { CHAT_PROVIDER_TOKEN } from '../llm/llm.module';
import type { ChatProvider } from '../llm/chat-provider.interface';
import { JobsRepository } from '../db/repositories/jobs.repository';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import { DEFAULT_RATE_LIMIT } from '../indexing/rate-limiter';
import type { ProviderStatusDto } from '../contracts';

@Injectable()
export class ProvidersService {
  constructor(
    @Inject(EMBEDDING_PROVIDER_TOKEN)
    private readonly embeddingProvider: EmbeddingProvider,
    @Inject(CHAT_PROVIDER_TOKEN) private readonly chatProvider: ChatProvider,
    private readonly jobsRepository: JobsRepository,
    private readonly projectsRepository: ProjectsRepository,
  ) {}

  async getStatus(): Promise<ProviderStatusDto> {
    const [requestsToday, projects] = await Promise.all([
      this.jobsRepository.sumEmbedRequestsToday(),
      this.projectsRepository.findAll(),
    ]);

    // Same mismatch RetrievalService.search checks reactively (and rejects
    // with a 400) on the next question asked against a stale project — this
    // just surfaces it proactively, for every project at once, instead of
    // waiting for someone to hit it.
    const staleProjects = projects
      .filter(
        (p) =>
          p.embeddingModel !== null &&
          p.embeddingModel !== this.embeddingProvider.id,
      )
      .map((p) => ({
        id: p.id,
        name: p.name,
        embeddingModel: p.embeddingModel,
      }));

    return {
      embedding: {
        id: this.embeddingProvider.id,
        requestsToday,
        requestsPerDay: DEFAULT_RATE_LIMIT.requestsPerDay,
      },
      chat: { id: this.chatProvider.id },
      staleProjects,
    };
  }
}
