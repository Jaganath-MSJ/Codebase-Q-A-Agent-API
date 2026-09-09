import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import { ChunksRepository } from '../db/repositories/chunks.repository';
import type { TourRecord } from '../db/schema';
import { CHAT_PROVIDER_TOKEN } from '../llm/llm.module';
import type { ChatProvider } from '../llm/chat-provider.interface';
import { EventBusService } from '../events/event-bus.service';
import { parseCitations } from '../common/citation-parser';
import { rankFiles, type RankableFile } from './file-ranking';
import { buildTourMapPrompt, buildTourReducePrompt, parseTourSections, type MarkedEvidence } from './tour-prompts';

const TOP_N_FILES = 30;
const MAP_BATCH_SIZE = 5;
// Phase 12.4: medium output cap for the tour's map + reduce steps (tunable).
const TOUR_MAX_TOKENS = 1024;

@Injectable()
export class TourService {
  private readonly logger = new Logger(TourService.name);

  constructor(
    private readonly projectsRepository: ProjectsRepository,
    private readonly chunksRepository: ChunksRepository,
    @Inject(CHAT_PROVIDER_TOKEN) private readonly chatProvider: ChatProvider,
    eventBus: EventBusService,
  ) {
    // `job.completed` fires for every outcome (succeeded, failed, canceled,
    // paused) — generate() itself decides whether there's anything to do.
    eventBus.on('job.completed').subscribe(({ projectId }) => {
      this.generate(projectId).catch((err) => {
        this.logger.error(`Tour generation failed for project ${projectId}: ${String(err)}`);
      });
    });
  }

  async getTour(projectId: string): Promise<TourRecord | null> {
    const project = await this.projectsRepository.findById(projectId);
    return project?.tour ?? null;
  }

  async generate(projectId: string, force = false): Promise<void> {
    const project = await this.projectsRepository.findById(projectId);
    if (!project || project.status !== 'ready' || !project.headRevision) return;

    // Same idempotency shape as the indexing early exit: skip regenerating a
    // tour that would come out identical, whether job.completed fired from an
    // unchanged re-index or from a failed re-index of an already-ready project.
    if (!force && project.tour?.revision === project.headRevision) return;

    const firstChunks = await this.chunksRepository.findFirstChunkPerFile(projectId);
    if (firstChunks.length === 0) return;

    const rankable: RankableFile[] = firstChunks.map((c) => ({ path: c.path, content: c.content }));
    const ranked = rankFiles(rankable, TOP_N_FILES);

    const byPath = new Map(firstChunks.map((c) => [c.path, c]));
    const evidence: MarkedEvidence[] = ranked
      .map((path, i) => {
        const chunk = byPath.get(path);
        if (!chunk) return null;
        return {
          marker: i + 1,
          block: { path, startLine: chunk.startLine, endLine: chunk.endLine, content: chunk.content },
        };
      })
      .filter((e): e is MarkedEvidence => e !== null);

    const groupSummaries: string[] = [];
    for (let i = 0; i < evidence.length; i += MAP_BATCH_SIZE) {
      const batch = evidence.slice(i, i + MAP_BATCH_SIZE);
      const { system, user } = buildTourMapPrompt(batch);
      const result = await this.chatProvider.complete({ system, user, maxTokens: TOUR_MAX_TOKENS });
      groupSummaries.push(result.text.trim());
    }
    if (groupSummaries.length === 0) return;

    const { system, user } = buildTourReducePrompt(groupSummaries);
    const reduced = await this.chatProvider.complete({ system, user, maxTokens: TOUR_MAX_TOKENS });

    const evidenceBlocks = evidence.map((e) => e.block);
    const sections = parseTourSections(reduced.text).map((section) => ({
      title: section.title,
      body: section.body,
      citations: parseCitations(section.body, evidenceBlocks),
    }));
    if (sections.length === 0) return;

    const overviewFirstLine = project.overview?.split('\n')[0] ?? project.name;
    const tour: TourRecord = {
      summary: overviewFirstLine,
      sections,
      generatedAt: new Date().toISOString(),
      revision: project.headRevision,
    };

    await this.projectsRepository.update(projectId, { tour });
  }
}
