import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class SearchRequestDto {
  @ApiProperty({ description: 'Project to search within' })
  @IsUUID()
  projectId!: string;

  @ApiProperty({ description: 'Free-text query' })
  @IsString()
  @IsNotEmpty()
  query!: string;
}

export class ScoredChunkDto {
  @ApiProperty()
  chunkId!: string;

  @ApiProperty()
  path!: string;

  @ApiProperty()
  startLine!: number;

  @ApiProperty()
  endLine!: number;

  @ApiProperty()
  content!: string;

  @ApiProperty()
  score!: number;
}
