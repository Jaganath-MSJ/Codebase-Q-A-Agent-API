import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class SearchRequestDto {
  @ApiProperty({ description: 'Project to search within' })
  @IsUUID()
  projectId!: string;

  @ApiProperty({ description: 'Free-text query' })
  @IsString()
  @IsNotEmpty()
  query!: string;

  @ApiProperty({ enum: ['vector', 'fts'], description: 'Which retriever to run' })
  @IsIn(['vector', 'fts'])
  mode!: 'vector' | 'fts';

  @ApiPropertyOptional({ description: 'Max results to return, default 20' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  k?: number;
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
