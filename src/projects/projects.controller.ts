import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOkResponse, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { ProjectsService } from './projects.service';
import { CreateProjectDto, ProjectDto } from '../contracts';
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
  constructor(private readonly projectsService: ProjectsService) {}

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
}
