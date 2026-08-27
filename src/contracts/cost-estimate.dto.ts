import { ApiProperty } from '@nestjs/swagger';

export class CostEstimateDto {
  @ApiProperty({
    description:
      'true if nothing on disk changed since the last successful index — indexing would be a no-op',
  })
  unchanged!: boolean;

  @ApiProperty({
    description:
      'Chunks the project will have after indexing (cached + toEmbed)',
  })
  totalChunks!: number;

  @ApiProperty({
    description:
      'Chunks belonging to files unchanged since the last index — their existing embedding is reused, no request needed',
  })
  cachedChunks!: number;

  @ApiProperty({
    description:
      'Chunks belonging to new or changed files — each needs a fresh embedding request',
  })
  toEmbedChunks!: number;

  @ApiProperty({
    description: 'ceil(toEmbedChunks / embedding provider batch size)',
  })
  estimatedRequests!: number;

  @ApiProperty({
    description: 'Embedding requests already made today, across all projects',
  })
  requestsToday!: number;

  @ApiProperty({
    description:
      "Today's embedding request budget (see indexing/rate-limiter.ts)",
  })
  requestsPerDay!: number;

  @ApiProperty({
    description: 'estimatedRequests as a percentage of requestsPerDay, rounded',
  })
  percentOfDailyQuota!: number;
}
