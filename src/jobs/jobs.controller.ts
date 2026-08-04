import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { JobsService } from './jobs.service';
import { JobDto } from '../contracts';
import { IndexingJobRow } from '../db/schema';

export function toJobDto(row: IndexingJobRow): JobDto {
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status,
    phase: row.phase,
    trigger: row.trigger,
    filesTotal: row.filesTotal,
    filesDone: row.filesDone,
    chunksTotal: row.chunksTotal,
    chunksEmbedded: row.chunksEmbedded,
    currentPath: row.currentPath,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

@ApiTags('jobs')
@Controller('projects/:projectId/jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Get('latest')
  @ApiOkResponse({ type: JobDto })
  async latest(@Param('projectId') projectId: string): Promise<JobDto> {
    const job = await this.jobsService.findLatest(projectId);
    if (!job) throw new NotFoundException(`No indexing jobs for project ${projectId}`);
    return toJobDto(job);
  }
}
