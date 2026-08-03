import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOkResponse, ApiCreatedResponse, ApiAcceptedResponse, ApiTags } from '@nestjs/swagger';
import { ProjectsService } from './projects.service';
import { JobsService } from '../jobs/jobs.service';
import { toJobDto } from '../jobs/jobs.controller';
import { CreateProjectDto, ProjectDto, JobDto } from '../contracts';
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
    createdAt: row.createdAt.toISOString(),
  };
}

@ApiTags('projects')
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly jobsService: JobsService,
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
  async index(@Param('id') id: string): Promise<JobDto> {
    const job = await this.jobsService.enqueue(id);
    return toJobDto(job);
  }
}
