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
import type { ProjectRow, NewChunkRow } from '../db/schema';

function langFromPath(relPath: string): string | null {
  const ext = path.extname(relPath).slice(1).toLowerCase();
  return ext || null;
}

@Injectable()
export class IndexingService {
  constructor(
    private readonly projectsRepository: ProjectsRepository,
    private readonly filesRepository: FilesRepository,
    private readonly chunksRepository: ChunksRepository,
    private readonly walkerService: WalkerService,
    @Inject(CHUNKER_TOKEN) private readonly chunker: Chunker,
  ) {}

  async indexProject(projectId: string): Promise<ProjectRow> {
    const project = await this.projectsRepository.findById(projectId);
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    const walked = await this.walkerService.walk(project.sourceRef);

    await this.filesRepository.deleteByProjectId(projectId);

    let chunkCount = 0;

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
    }

    const updated = await this.projectsRepository.updateCounts(projectId, {
      status: 'indexed',
      fileCount: walked.length,
      chunkCount,
    });
    if (!updated) throw new NotFoundException(`Project ${projectId} not found`);

    return updated;
  }
}
