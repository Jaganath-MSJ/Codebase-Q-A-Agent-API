import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { JobDto } from './job.dto';

export class CreateProjectDto {
  @ApiProperty({ description: 'Display name for the project' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({
    enum: ['local_path', 'git_url', 'zip_upload', 'git_private'],
    default: 'local_path',
  })
  @IsOptional()
  @IsIn(['local_path', 'git_url', 'zip_upload', 'git_private'])
  sourceKind?: string;

  @ApiProperty({
    description:
      'Absolute local folder path, an https://github.com/... URL (git_url/git_private), or (zip_upload) the uploadId from POST /uploads',
  })
  @IsString()
  @IsNotEmpty()
  sourceRef!: string;

  @ApiPropertyOptional({ description: 'git_url/git_private only — defaults to the repo’s default branch' })
  @IsOptional()
  @IsString()
  branch?: string;

  @ApiPropertyOptional({
    description: 'git_private only — a GitHub PAT, encrypted at rest and never returned by the API',
  })
  @IsOptional()
  @IsString()
  token?: string;
}

export class ProjectDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  sourceKind!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  fileCount!: number;

  @ApiProperty()
  chunkCount!: number;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Digest injected into every chat prompt; null until the first successful index',
  })
  overview?: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty({
    type: () => JobDto,
    nullable: true,
    description:
      'Latest indexing job for this project (Phase 12.16), or null if never indexed — lets the dashboard read job state from the list instead of one fetch per project',
  })
  latestJob!: JobDto | null;
}
