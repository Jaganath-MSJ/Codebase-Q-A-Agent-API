import { Injectable } from '@nestjs/common';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import { ProjectRow } from '../db/schema';
import { CreateProjectDto } from '../contracts';

@Injectable()
export class ProjectsService {
  constructor(private readonly projectsRepository: ProjectsRepository) {}

  async create(dto: CreateProjectDto): Promise<ProjectRow> {
    return this.projectsRepository.create({ name: dto.name, sourceRef: dto.sourceRef });
  }

  async findAll(): Promise<ProjectRow[]> {
    return this.projectsRepository.findAll();
  }
}
