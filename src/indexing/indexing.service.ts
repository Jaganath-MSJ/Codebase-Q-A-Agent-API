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

export interface IndexProgress {
  phase: 'walking' | 'chunking' | 'embedding' | 'finalizing';
  currentPath?: string;
  filesDone?: number;
  filesTotal?: number;
  chunksTotal?: number;
  chunksEmbedded?: number;
}

export type OnIndexProgress = (update: IndexProgress) => Promise<void> | void;

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

  async indexProject(projectId: string, onProgress?: OnIndexProgress): Promise<ProjectRow> {
    const project = await this.projectsRepository.findById(projectId);
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    await onProgress?.({ phase: 'walking' });
    const walked = await this.walkerService.walk(project.sourceRef);

    const existing = await this.filesRepository.findAllByProjectId(projectId);
    const existingByPath = new Map(existing.map((file) => [file.path, file]));
    const walkedPaths = new Set(walked.map((entry) => entry.relPath));

    const staleIds = existing.filter((file) => !walkedPaths.has(file.path)).map((file) => file.id);
    await this.filesRepository.deleteByIds(staleIds);

    let filesDone = 0;
    await onProgress?.({ phase: 'chunking', filesDone, filesTotal: walked.length });

    for (const entry of walked) {
      const { text, lines } = await readSourceFile(entry.absPath);
      const contentHash = sha256(text);
      const existingFile = existingByPath.get(entry.relPath);

      // Unchanged since the last index: leave its files/chunks row untouched,
      // including any embedding it already has — this is what makes a
      // re-index of an unchanged repo skip chunking AND embedding entirely.
      if (!existingFile || existingFile.contentHash !== contentHash) {
        const chunkList = this.chunker.chunk(lines);
        const chunkRows: Omit<NewChunkRow, 'projectId' | 'fileId'>[] = chunkList.map((chunk) => ({
          ord: chunk.ord,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: chunk.content,
          contentHash: sha256(chunk.content),
        }));

        await this.filesRepository.replaceFile(
          projectId,
          existingFile?.id,
          { path: entry.relPath, lang: langFromPath(entry.relPath), contentHash, lineCount: lines.length },
          chunkRows,
        );
      }

      filesDone++;
      await onProgress?.({
        phase: 'chunking',
        currentPath: entry.relPath,
        filesDone,
        filesTotal: walked.length,
      });
    }

    const chunkCount = await this.chunksRepository.countByProjectId(projectId);
    await this.projectsRepository.update(projectId, {
      status: 'indexed',
      fileCount: walked.length,
      chunkCount,
    });

    await this.embedPendingChunks(projectId, onProgress);
    await onProgress?.({ phase: 'finalizing' });

    const updated = await this.projectsRepository.update(projectId, {
      status: 'ready',
      embeddingModel: this.embeddingProvider.id,
      embeddingDim: this.embeddingProvider.dimensions,
    });
    if (!updated) throw new NotFoundException(`Project ${projectId} not found`);

    return updated;
  }

  private async embedPendingChunks(projectId: string, onProgress?: OnIndexProgress): Promise<void> {
    if (this.embeddingProvider.dimensions !== 768) {
      throw new Error(
        `Embedding provider '${this.embeddingProvider.id}' reports ${this.embeddingProvider.dimensions} dimensions; this project requires exactly 768.`,
      );
    }

    const pending = await this.chunksRepository.findWithoutEmbedding(projectId);
    const chunksTotal = pending.length;
    let chunksEmbedded = 0;
    await onProgress?.({ phase: 'embedding', chunksTotal, chunksEmbedded });

    for (const group of batch(pending, this.embeddingProvider.maxBatchSize)) {
      const vectors = await this.embeddingProvider.embedDocuments(group.map((c) => c.content));
      for (let i = 0; i < group.length; i++) {
        const chunk = group[i]!;
        const vector = vectors[i]!;
        await this.chunksRepository.setEmbedding(chunk.id, vector);
      }
      chunksEmbedded += group.length;
      await onProgress?.({ phase: 'embedding', chunksTotal, chunksEmbedded });
    }
  }
}
