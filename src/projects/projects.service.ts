import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import { ProjectRow } from '../db/schema';
import { CreateProjectDto, FileViewDto } from '../contracts';
import { resolveInside } from '../common/paths';
import { readSourceFile } from '../common/read-file';
import { resolveUploadPath } from '../common/upload-id';
import { ConfigService } from '../config/config.service';

@Injectable()
export class ProjectsService {
  constructor(
    private readonly projectsRepository: ProjectsRepository,
    private readonly config: ConfigService,
  ) {}

  async create(dto: CreateProjectDto): Promise<ProjectRow> {
    const sourceKind = dto.sourceKind ?? 'local_path';

    // Fails fast at creation time rather than at first-index time — the
    // upload is a one-shot handle (ZipUploadAdapter deletes it after
    // extraction), so a typo'd or already-consumed uploadId should surface
    // immediately, not after the user has already named and submitted the
    // project. `sourceRef` is otherwise unvalidated client JSON body input —
    // resolveUploadPath rejects anything that isn't a real uploadId shape
    // before it ever reaches the filesystem, so it can't be used to probe
    // for or read an arbitrary file elsewhere on disk as though it were an
    // uploaded zip.
    if (sourceKind === 'zip_upload') {
      let uploadPath: string;
      try {
        uploadPath = resolveUploadPath(path.join(this.config.dataDir, 'uploads'), dto.sourceRef);
      } catch {
        throw new BadRequestException(`Not a valid uploadId: ${dto.sourceRef}`);
      }
      if (!existsSync(uploadPath)) {
        throw new BadRequestException(`Upload ${dto.sourceRef} not found — upload the zip first`);
      }
    }

    return this.projectsRepository.create({
      name: dto.name,
      sourceKind,
      sourceRef: dto.sourceRef,
      defaultBranch: dto.branch,
    });
  }

  async findAll(): Promise<ProjectRow[]> {
    return this.projectsRepository.findAll();
  }

  /**
   * Reads straight from disk and re-derives the range independently of the
   * stored citation snapshot — a stale line-range mismatch becomes visible
   * here rather than looking plausible.
   */
  async getFile(
    projectId: string,
    relPath: string,
    startLine: number,
    endLine: number,
    context: number,
  ): Promise<FileViewDto> {
    const project = await this.projectsRepository.findById(projectId);
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    // `workspacePath` is where the adapter actually put the files on disk —
    // for git_url that's `data/workspaces/<id>`, not the clone URL in
    // `sourceRef`. It's only null for a project that has never been indexed,
    // which has no citations to view yet.
    const root = project.workspacePath ?? project.sourceRef;
    let absPath: string;
    try {
      absPath = resolveInside(root, relPath);
    } catch {
      throw new BadRequestException(`Path escapes the project root: ${relPath}`);
    }

    let lines: string[];
    try {
      ({ lines } = await readSourceFile(absPath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundException(`File not found on disk: ${relPath}`);
      }
      throw err;
    }

    const contextStart = Math.max(1, startLine - context);
    const contextEnd = Math.min(lines.length, endLine + context);

    return {
      path: relPath,
      startLine,
      endLine,
      contextStart,
      contextEnd,
      lines: lines.slice(contextStart - 1, contextEnd),
    };
  }
}
