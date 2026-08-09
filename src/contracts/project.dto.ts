import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateProjectDto {
  @ApiProperty({ description: 'Display name for the project' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ enum: ['local_path', 'git_url'], default: 'local_path' })
  @IsOptional()
  @IsIn(['local_path', 'git_url'])
  sourceKind?: string;

  @ApiProperty({ description: 'Absolute local folder path, or an https://github.com/... URL' })
  @IsString()
  @IsNotEmpty()
  sourceRef!: string;

  @ApiPropertyOptional({ description: 'git_url only — defaults to the repo’s default branch' })
  @IsOptional()
  @IsString()
  branch?: string;
}

export class ProjectDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  sourceKind!: string;

  @ApiProperty()
  sourceRef!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  fileCount!: number;

  @ApiProperty()
  chunkCount!: number;

  @ApiProperty()
  createdAt!: string;
}
