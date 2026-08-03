import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import * as path from 'node:path';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import { FilesRepository } from '../db/repositories/files.repository';
import { ChunksRepository } from '../db/repositories/chunks.repository';
import { WalkerService } from '../walker/walker.service';
import { readSourceFile } from '../common/read-file';
import { sha256 } from '../common/hash';
import { CHUNKER_TOKEN } from '../chunking/chunking.module';
import type { Chunker } from '../chunking/chunker.interface';
import { EMBEDDING_PROVIDER_TOKEN } from '../embeddings/embeddings.module';
import type { EmbeddingProvider } from '../embeddings/embedding-provider.interface';
import type { ProjectRow, NewChunkRow } from '../db/schema';

function langFromPath(relPath: string): string | null {
  const ext = path.extname(relPath).slice(1).toLowerCase();
  return ext || null;
}

function batch<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

@Injectable()
export class IndexingService {
  constructor(
    private readonly projectsRepository: ProjectsRepository,
    private readonly filesRepository: FilesRepository,
    private readonly chunksRepository: ChunksRepository,
    private readonly walkerService: WalkerService,
    @Inject(CHUNKER_TOKEN) private readonly chunker: Chunker,
    @Inject(EMBEDDING_PROVIDER_TOKEN) private readonly embeddingProvider: EmbeddingProvider,
  ) {}

  async indexProject(
    projectId: string,
    onProgress?: (filesDone: number, filesTotal: number) => Promise<void> | void,
  ): Promise<ProjectRow> {
    const project = await this.projectsRepository.findById(projectId);
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    const walked = await this.walkerService.walk(project.sourceRef);
    await onProgress?.(0, walked.length);

    await this.filesRepository.deleteByProjectId(projectId);

    let chunkCount = 0;
    let filesDone = 0;

    for (const entry of walked) {
      const { text, lines } = await readSourceFile(entry.absPath);

      const [fileRow] = await this.filesRepository.insertMany([
        {
          projectId,
          path: entry.relPath,
          lang: langFromPath(entry.relPath),
          contentHash: sha256(text),
          lineCount: lines.length,
        },
      ]);
      if (!fileRow) throw new Error(`Failed to insert file row for ${entry.relPath}`);

      const chunks = this.chunker.chunk(lines);
      const chunkRows: NewChunkRow[] = chunks.map((chunk) => ({
        projectId,
        fileId: fileRow.id,
        ord: chunk.ord,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        contentHash: sha256(chunk.content),
      }));

      await this.chunksRepository.insertMany(chunkRows);
      chunkCount += chunkRows.length;

      filesDone++;
      await onProgress?.(filesDone, walked.length);
    }

    await this.projectsRepository.update(projectId, {
      status: 'indexed',
      fileCount: walked.length,
      chunkCount,
    });

    await this.embedPendingChunks(projectId);

    const updated = await this.projectsRepository.update(projectId, {
      status: 'ready',
      embeddingModel: this.embeddingProvider.id,
      embeddingDim: this.embeddingProvider.dimensions,
    });
    if (!updated) throw new NotFoundException(`Project ${projectId} not found`);

    return updated;
  }

  private async embedPendingChunks(projectId: string): Promise<void> {
    if (this.embeddingProvider.dimensions !== 768) {
      throw new Error(
        `Embedding provider '${this.embeddingProvider.id}' reports ${this.embeddingProvider.dimensions} dimensions; this project requires exactly 768.`,
      );
    }

    const pending = await this.chunksRepository.findWithoutEmbedding(projectId);

    for (const group of batch(pending, this.embeddingProvider.maxBatchSize)) {
      const vectors = await this.embeddingProvider.embedDocuments(group.map((c) => c.content));
      for (let i = 0; i < group.length; i++) {
        const chunk = group[i]!;
        const vector = vectors[i]!;
        await this.chunksRepository.setEmbedding(chunk.id, vector);
      }
    }
  }
}
