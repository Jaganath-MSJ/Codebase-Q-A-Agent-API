import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateProjectDto {
  @ApiProperty({ description: 'Display name for the project' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ description: 'Absolute local folder path to index' })
  @IsString()
  @IsNotEmpty()
  sourceRef!: string;
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
