import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import { ProjectRow } from '../db/schema';
import { CreateProjectDto, FileViewDto } from '../contracts';
import { resolveInside } from '../common/paths';
import { readSourceFile } from '../common/read-file';

@Injectable()
export class ProjectsService {
  constructor(private readonly projectsRepository: ProjectsRepository) {}

  async create(dto: CreateProjectDto): Promise<ProjectRow> {
    return this.projectsRepository.create({ name: dto.name, sourceRef: dto.sourceRef });
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

    let absPath: string;
    try {
      absPath = resolveInside(project.sourceRef, relPath);
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
