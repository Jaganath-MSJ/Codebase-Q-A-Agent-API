import { ApiProperty } from '@nestjs/swagger';

export class ProjectStorageDto {
  @ApiProperty({ description: 'Number of indexed chunks for this project' })
  chunkCount!: number;

  @ApiProperty({
    description:
      'Bytes of chunk source text (the `content` column), summed for this project',
  })
  contentBytes!: number;

  @ApiProperty({
    description:
      'Bytes of embedding vectors (the `embedding` column), summed for this project',
  })
  vectorBytes!: number;

  @ApiProperty({
    description:
      "Bytes used by the chunks table's indexes (FTS + trigram) across ALL projects — indexes aren't " +
      "partitioned per project, so this is a shared, whole-database number, not this project's share",
  })
  sharedIndexBytes!: number;

  @ApiProperty({
    description:
      'Total size of the Postgres database backing this deployment, in bytes',
  })
  databaseBytes!: number;

  @ApiProperty({
    description:
      'The free-tier storage budget this project is measured against, in bytes',
  })
  databaseBudgetBytes!: number;

  @ApiProperty({
    description: 'databaseBytes as a percentage of databaseBudgetBytes',
  })
  databaseUsedPercent!: number;
}
