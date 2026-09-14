import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiCreatedResponse,
  ApiAcceptedResponse,
  ApiNoContentResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ProjectsService } from './projects.service';
import { JobsService } from '../jobs/jobs.service';
import { IndexingService } from '../indexing/indexing.service';
import { toJobDto } from '../jobs/jobs.controller';
import {
  CreateProjectDto,
  ProjectDto,
  JobDto,
  FileQueryDto,
  FileViewDto,
  IndexRequestDto,
  ProjectStorageDto,
  CostEstimateDto,
} from '../contracts';
import { ProjectRow } from '../db/schema';

function toDto(row: ProjectRow, latestJob: JobDto | null = null): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    sourceKind: row.sourceKind,
    status: row.status,
    fileCount: row.fileCount,
    chunkCount: row.chunkCount,
    overview: row.overview,
    createdAt: row.createdAt.toISOString(),
    latestJob,
  };
}

@ApiTags('projects')
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly jobsService: JobsService,
    private readonly indexingService: IndexingService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiCreatedResponse({ type: ProjectDto })
  async create(@Body() dto: CreateProjectDto): Promise<ProjectDto> {
    const row = await this.projectsService.create(dto);
    return toDto(row);
  }

  @Get()
  @ApiOkResponse({ type: ProjectDto, isArray: true })
  async findAll(): Promise<ProjectDto[]> {
    const rows = await this.projectsService.findAll();
    // One batched query for every project's latest job (Phase 12.16) so the
    // dashboard reads job state from this list instead of a fetch per row.
    const latest = await this.jobsService.findLatestForProjects(
      rows.map((r) => r.id),
    );
    return rows.map((row) => {
      const job = latest.get(row.id);
      return toDto(row, job ? toJobDto(job) : null);
    });
  }

  @Post(':id/index')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: JobDto })
  async index(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: IndexRequestDto,
  ): Promise<JobDto> {
    const job = await this.jobsService.enqueue(
      id,
      body.force ? 'force' : 'initial',
    );
    return toJobDto(job);
  }

  @Get(':id/cost-estimate')
  @ApiOkResponse({ type: CostEstimateDto })
  async getCostEstimate(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CostEstimateDto> {
    return this.indexingService.estimateIndexCost(id);
  }

  @Get(':id/file')
  @ApiOkResponse({ type: FileViewDto })
  async getFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: FileQueryDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { etag, dto } = await this.projectsService.getFile(
      id,
      query.path,
      query.startLine,
      query.endLine,
      query.context ?? 20,
      req.headers['if-none-match'],
    );
    // Source content is immutable within an index, so revalidate cheaply via the
    // ETag on a cold reload / cross-session (Phase 13.6) — in-session, the web's
    // staleTime:Infinity (13.2) already avoids the request. `private`: user-scoped
    // source, never shared-cached; `max-age=0, must-revalidate`: always check the
    // ETag, which a matching If-None-Match answers with a 304 (no disk read, no body).
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    res.setHeader('ETag', etag);
    if (!dto) {
      res.status(HttpStatus.NOT_MODIFIED).end();
      return;
    }
    res.status(HttpStatus.OK).json(dto);
  }

  @Get(':id/storage')
  @ApiOkResponse({ type: ProjectStorageDto })
  async getStorage(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ProjectStorageDto> {
    return this.projectsService.getStorage(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.indexingService.deleteProject(id);
  }
}
