import { ApiProperty } from '@nestjs/swagger';

export class JobDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  projectId!: string;

  @ApiProperty({ enum: ['queued', 'running', 'succeeded', 'failed', 'canceled'] })
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
  chunksTotal!: number;

  @ApiProperty()
  chunksEmbedded!: number;

  @ApiProperty({ type: String, nullable: true })
  currentPath!: string | null;

  @ApiProperty({ type: String, nullable: true })
  errorMessage!: string | null;

  @ApiProperty({ type: String, nullable: true })
  startedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  finishedAt!: string | null;

  @ApiProperty()
  createdAt!: string;
}
