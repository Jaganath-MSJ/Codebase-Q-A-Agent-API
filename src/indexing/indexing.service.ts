import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as path from 'node:path';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import { FilesRepository } from '../db/repositories/files.repository';
import { ChunksRepository } from '../db/repositories/chunks.repository';
import { JobsRepository } from '../db/repositories/jobs.repository';
import { WalkerService } from '../walker/walker.service';
import { readSourceFile } from '../common/read-file';
import { sha256 } from '../common/hash';
import { CHUNKER_TOKEN } from '../chunking/chunking.module';
import type { Chunker } from '../chunking/chunker.interface';
import { buildSearchText } from '../retrieval/identifiers';
import { EMBEDDING_PROVIDER_TOKEN } from '../embeddings/embeddings.module';
import type { EmbeddingProvider } from '../embeddings/embedding-provider.interface';
import { SourceAdapterRegistry } from '../sources/source-adapter.registry';
import { RepoOverviewService } from '../overview/repo-overview.service';
import type { OverviewFileEntry } from '../overview/overview-digest';
import { EmbeddingRateLimiter, withEmbeddingRetry } from './rate-limiter';
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
  filesSkipped?: number;
  skipReasons?: Record<string, number>;
  chunksTotal?: number;
  chunksEmbedded?: number;
  embedRequests?: number;
}

export type OnIndexProgress = (update: IndexProgress) => Promise<void> | void;
export type ShouldCancel = () => Promise<boolean>;

// Matches the unique `one_active_job_per_project` index's WHERE clause.
const ACTIVE_JOB_STATUSES = new Set(['queued', 'running', 'paused']);

export class IndexCanceledError extends Error {}

@Injectable()
export class IndexingService {
  private readonly logger = new Logger(IndexingService.name);

  constructor(
    private readonly projectsRepository: ProjectsRepository,
    private readonly filesRepository: FilesRepository,
    private readonly chunksRepository: ChunksRepository,
    private readonly jobsRepository: JobsRepository,
    private readonly walkerService: WalkerService,
    private readonly sourceAdapterRegistry: SourceAdapterRegistry,
    private readonly repoOverviewService: RepoOverviewService,
    private readonly rateLimiter: EmbeddingRateLimiter,
    @Inject(CHUNKER_TOKEN) private readonly chunker: Chunker,
    @Inject(EMBEDDING_PROVIDER_TOKEN) private readonly embeddingProvider: EmbeddingProvider,
  ) {}

  async indexProject(
    projectId: string,
    onProgress?: OnIndexProgress,
    shouldCancel?: ShouldCancel,
    force = false,
  ): Promise<ProjectRow> {
    const project = await this.projectsRepository.findById(projectId);
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    await onProgress?.({ phase: 'walking' });
    const adapter = this.sourceAdapterRegistry.getAdapter(project.sourceKind);
    const { workspacePath, revision } = await adapter.materialize(project);
    await this.projectsRepository.update(projectId, { workspacePath });

    // Nothing on disk changed since the last successful index — skip the walk
    // entirely rather than re-discovering that every file is unchanged one by
    // one. `headRevision` is only null before a project's first index, which
    // must never short-circuit.
    if (!force && project.headRevision && revision === project.headRevision) {
      await onProgress?.({ phase: 'finalizing' });
      const unchanged = await this.projectsRepository.findById(projectId);
      if (!unchanged) throw new NotFoundException(`Project ${projectId} not found`);
      return unchanged;
    }

    // `skipReasons` starts as the walker's tally (gitignored, binary, minified, ...)
    // and gains an `unchanged` entry below as content-hash diffing finds files that
    // don't need re-chunking. Both are "skipped", just at different pipeline stages —
    // on a fully-unchanged re-index, `unchanged` dominates and filesSkipped ≈ filesTotal.
    const walkResult = await this.walkerService.walk(workspacePath);
    const walked = walkResult.included;
    const skipReasons: Record<string, number> = { ...walkResult.skipReasons };
    const bumpSkipped = (reason: string): number => {
      skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
      return Object.values(skipReasons).reduce((sum, n) => sum + n, 0);
    };

    const existing = await this.filesRepository.findAllByProjectId(projectId);
    const existingByPath = new Map(existing.map((file) => [file.path, file]));
    const walkedPaths = new Set(walked.map((entry) => entry.relPath));

    const staleIds = existing.filter((file) => !walkedPaths.has(file.path)).map((file) => file.id);
    await this.filesRepository.deleteByIds(staleIds);

    let filesDone = 0;
    let filesSkipped = Object.values(skipReasons).reduce((sum, n) => sum + n, 0);
    await onProgress?.({ phase: 'chunking', filesDone, filesTotal: walked.length, filesSkipped, skipReasons });

    for (const entry of walked) {
      if (await shouldCancel?.()) throw new IndexCanceledError(`Canceled during chunking at ${entry.relPath}`);

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
          searchText: buildSearchText(chunk.content),
        }));

        await this.filesRepository.replaceFile(
          projectId,
          existingFile?.id,
          { path: entry.relPath, lang: langFromPath(entry.relPath), contentHash, lineCount: lines.length },
          chunkRows,
        );
      } else {
        filesSkipped = bumpSkipped('unchanged');
      }

      filesDone++;
      await onProgress?.({
        phase: 'chunking',
        currentPath: entry.relPath,
        filesDone,
        filesTotal: walked.length,
        filesSkipped,
        skipReasons,
      });
    }

    const chunkCount = await this.chunksRepository.countByProjectId(projectId);
    await this.projectsRepository.update(projectId, {
      status: 'indexed',
      fileCount: walked.length,
      chunkCount,
    });

    await this.embedPendingChunks(projectId, onProgress, shouldCancel);
    await onProgress?.({ phase: 'finalizing' });

    // Reuses the walk already done above rather than a third full tree scan —
    // only package.json and the README get their own (single-file) reads.
    const fileLangs: OverviewFileEntry[] = walked.map((entry) => ({
      relPath: entry.relPath,
      lang: langFromPath(entry.relPath),
    }));
    const overview = await this.repoOverviewService.generate(workspacePath, project.name, fileLangs);

    const updated = await this.projectsRepository.update(projectId, {
      status: 'ready',
      headRevision: revision,
      embeddingModel: this.embeddingProvider.id,
      embeddingDim: this.embeddingProvider.dimensions,
      overview,
    });
    if (!updated) throw new NotFoundException(`Project ${projectId} not found`);

    return updated;
  }

  /**
   * Rejects while a job is queued/running/paused (the same set the unique
   * `one_active_job_per_project` index guards) — deleting mid-index would
   * race the worker's own `materialize()`/chunk-insert calls against this
   * cleanup, corrupting neither but landing exactly the concurrent-write
   * EBUSY window the phase doc warns is otherwise rare. Deletes the DB row
   * first (cascading to files/chunks/jobs/conversations), then cleans up the
   * on-disk workspace — a cleanup failure (e.g. `fs.rm` exhausting its
   * `EBUSY` retries) is logged, not thrown, since the project is already
   * gone from every listing at that point and a leftover directory is a
   * disk-space concern, not a correctness one. Leaving the DB row in place
   * until cleanup succeeds would instead risk a project the user can never
   * get rid of if cleanup keeps failing.
   */
  async deleteProject(projectId: string): Promise<void> {
    const project = await this.projectsRepository.findById(projectId);
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    const latestJob = await this.jobsRepository.findLatestByProject(projectId);
    if (latestJob && ACTIVE_JOB_STATUSES.has(latestJob.status)) {
      throw new ConflictException(`Project ${projectId} has an active indexing job — cancel it first`);
    }

    await this.projectsRepository.delete(projectId);

    try {
      const adapter = this.sourceAdapterRegistry.getAdapter(project.sourceKind);
      await adapter.cleanup(project);
    } catch (err) {
      this.logger.error(`Workspace cleanup failed for deleted project ${projectId}: ${String(err)}`);
    }
  }

  private async embedPendingChunks(
    projectId: string,
    onProgress?: OnIndexProgress,
    shouldCancel?: ShouldCancel,
  ): Promise<void> {
    if (this.embeddingProvider.dimensions !== 768) {
      throw new Error(
        `Embedding provider '${this.embeddingProvider.id}' reports ${this.embeddingProvider.dimensions} dimensions; this project requires exactly 768.`,
      );
    }

    const pending = await this.chunksRepository.findWithoutEmbedding(projectId);
    const chunksTotal = pending.length;
    let chunksEmbedded = 0;
    let embedRequests = 0;
    await onProgress?.({ phase: 'embedding', chunksTotal, chunksEmbedded, embedRequests });

    for (const group of batch(pending, this.embeddingProvider.maxBatchSize)) {
      if (await shouldCancel?.()) throw new IndexCanceledError('Canceled during embedding');

      await this.rateLimiter.reserve();
      const vectors = await withEmbeddingRetry(async () => {
        const result = await this.embeddingProvider.embedDocuments(group.map((c) => c.content));
        // The provider can return a short or malformed batch without throwing
        // (observed with the local ONNX model under memory pressure) — turn that
        // into a loud, retryable error instead of a cryptic pgvector dimension
        // mismatch several layers away.
        if (result.length !== group.length) {
          throw new Error(
            `Embedding provider returned ${result.length} vectors for a batch of ${group.length} chunks`,
          );
        }
        const badIndex = result.findIndex((v) => v.length !== this.embeddingProvider.dimensions);
        if (badIndex !== -1) {
          throw new Error(
            `Embedding provider returned a ${result[badIndex]!.length}-dimensional vector at batch index ${badIndex}, expected ${this.embeddingProvider.dimensions}`,
          );
        }
        return result;
      });
      embedRequests++;

      for (let i = 0; i < group.length; i++) {
        const chunk = group[i]!;
        const vector = vectors[i]!;
        await this.chunksRepository.setEmbedding(chunk.id, vector);
      }
      chunksEmbedded += group.length;
      await onProgress?.({ phase: 'embedding', chunksTotal, chunksEmbedded, embedRequests });
    }
  }
}
