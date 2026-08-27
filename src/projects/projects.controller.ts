import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiCreatedResponse, ApiAcceptedResponse, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
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

function toDto(row: ProjectRow): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    sourceKind: row.sourceKind,
    sourceRef: row.sourceRef,
    status: row.status,
    fileCount: row.fileCount,
    chunkCount: row.chunkCount,
    overview: row.overview,
    createdAt: row.createdAt.toISOString(),
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
    return rows.map(toDto);
  }

  @Post(':id/index')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: JobDto })
  async index(@Param('id') id: string, @Body() body: IndexRequestDto): Promise<JobDto> {
    const job = await this.jobsService.enqueue(id, body.force ? 'force' : 'initial');
    return toJobDto(job);
  }

  @Get(':id/cost-estimate')
  @ApiOkResponse({ type: CostEstimateDto })
  async getCostEstimate(@Param('id') id: string): Promise<CostEstimateDto> {
    return this.indexingService.estimateIndexCost(id);
  }

  @Get(':id/file')
  @ApiOkResponse({ type: FileViewDto })
  async getFile(@Param('id') id: string, @Query() query: FileQueryDto): Promise<FileViewDto> {
    return this.projectsService.getFile(
      id,
      query.path,
      query.startLine,
      query.endLine,
      query.context ?? 20,
    );
  }

  @Get(':id/storage')
  @ApiOkResponse({ type: ProjectStorageDto })
  async getStorage(@Param('id') id: string): Promise<ProjectStorageDto> {
    return this.projectsService.getStorage(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async remove(@Param('id') id: string): Promise<void> {
    await this.indexingService.deleteProject(id);
  }
}
