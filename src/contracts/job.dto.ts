import { ApiProperty } from '@nestjs/swagger';

export class JobDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  projectId!: string;

  @ApiProperty({ enum: ['queued', 'running', 'succeeded', 'failed', 'canceled'] })
  status!: string;

  @ApiProperty()
  trigger!: string;

  @ApiProperty()
  filesTotal!: number;

  @ApiProperty()
  filesDone!: number;

  @ApiProperty({ type: String, nullable: true })
  errorMessage!: string | null;

  @ApiProperty({ type: String, nullable: true })
  startedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  finishedAt!: string | null;

  @ApiProperty()
  createdAt!: string;
}
