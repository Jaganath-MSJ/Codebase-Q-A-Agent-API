import {
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOkResponse, ApiAcceptedResponse, ApiTags } from '@nestjs/swagger';
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
    attempt: row.attempt,
    filesTotal: row.filesTotal,
    filesDone: row.filesDone,
    filesSkipped: row.filesSkipped,
    skipReasons: row.skipReasons,
    chunksTotal: row.chunksTotal,
    chunksEmbedded: row.chunksEmbedded,
    embedRequests: row.embedRequests,
    currentPath: row.currentPath,
    cancelRequested: row.cancelRequested,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

@ApiTags('jobs')
@Controller()
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Get('projects/:projectId/jobs/latest')
  @ApiOkResponse({ type: JobDto })
  async latest(
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ): Promise<JobDto> {
    const job = await this.jobsService.findLatest(projectId);
    if (!job)
      throw new NotFoundException(`No indexing jobs for project ${projectId}`);
    return toJobDto(job);
  }

  @Post('jobs/:jobId/cancel')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({
    schema: { properties: { status: { enum: ['canceled', 'canceling'] } } },
  })
  async cancel(
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ): Promise<{ status: 'canceled' | 'canceling' }> {
    const result = await this.jobsService.cancel(jobId);
    if (!result) throw new ConflictException(`Job ${jobId} is not active`);
    return { status: result };
  }
}
