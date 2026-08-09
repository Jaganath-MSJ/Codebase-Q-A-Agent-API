import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class IndexRequestDto {
  @ApiPropertyOptional({
    description: 'Bypass the revision early-exit and re-walk even if nothing changed',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class JobDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  projectId!: string;

  @ApiProperty({ enum: ['queued', 'running', 'succeeded', 'failed', 'canceled', 'paused'] })
  status!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['acquiring', 'walking', 'chunking', 'embedding', 'finalizing'],
  })
  phase!: string | null;

  @ApiProperty()
  trigger!: string;

  @ApiProperty()
  attempt!: number;

  @ApiProperty()
  filesTotal!: number;

  @ApiProperty()
  filesDone!: number;

  @ApiProperty()
  filesSkipped!: number;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  skipReasons!: Record<string, number>;

  @ApiProperty()
  chunksTotal!: number;

  @ApiProperty()
  chunksEmbedded!: number;

  @ApiProperty()
  embedRequests!: number;

  @ApiProperty({ type: String, nullable: true })
  currentPath!: string | null;

  @ApiProperty()
  cancelRequested!: boolean;

  @ApiProperty({ type: String, nullable: true })
  errorMessage!: string | null;

  @ApiProperty({ type: String, nullable: true })
  startedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  finishedAt!: string | null;

  @ApiProperty()
  createdAt!: string;
}
