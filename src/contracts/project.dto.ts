import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { JobDto } from './job.dto';

/** Display-length ceiling for a project name — see DEF-019. */
export const PROJECT_NAME_MAX_LENGTH = 200;

export class CreateProjectDto {
  @ApiProperty({
    description: 'Display name for the project',
    maxLength: PROJECT_NAME_MAX_LENGTH,
  })
  @IsString()
  // DEF-019, the same root cause as DEF-025 on the chat DTO: `@IsNotEmpty()`
  // rejects '' but passes '   ', so a project could be created with a
  // whitespace-only name and then rendered as a nameless row in the sidebar,
  // the library grid and the command palette — unfindable by name anywhere.
  // Trimming first closes that and normalises the rest, so "Demo " and "Demo"
  // are not two differently-named projects.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsNotEmpty()
  // The other half: there was no ceiling at all, so a 10,000-character name was
  // accepted and stored. The limit is a display concern rather than a storage
  // one (the column is `text`), which is why it is generous — long enough for
  // any real path-derived name, short enough not to break every layout.
  @MaxLength(PROJECT_NAME_MAX_LENGTH)
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

  @ApiPropertyOptional({
    description:
      'git_url/git_private only — defaults to the repo’s default branch',
  })
  @IsOptional()
  @IsString()
  branch?: string;

  @ApiPropertyOptional({
    description:
      'git_private only — a GitHub PAT, encrypted at rest and never returned by the API',
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
    description:
      'Digest injected into every chat prompt; null until the first successful index',
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
