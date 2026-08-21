import { ApiProperty } from '@nestjs/swagger';

export class EmbeddingProviderStatusDto {
  @ApiProperty({ description: "The active embedding provider's id, e.g. local:nomic-ai/nomic-embed-text-v1.5" })
  id!: string;

  @ApiProperty({ description: "Today's embedding requests across every indexing job, reset at midnight" })
  requestsToday!: number;

  @ApiProperty({ description: 'The daily embedding request budget this provider is paced against' })
  requestsPerDay!: number;
}

export class ChatProviderStatusDto {
  @ApiProperty({ description: "The active chat provider's id, e.g. gemini:gemini-flash-latest" })
  id!: string;
}

export class StaleProjectDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The embedding model this project was last indexed with' })
  embeddingModel!: string | null;
}

export class ProviderStatusDto {
  @ApiProperty({ type: EmbeddingProviderStatusDto })
  embedding!: EmbeddingProviderStatusDto;

  @ApiProperty({ type: ChatProviderStatusDto })
  chat!: ChatProviderStatusDto;

  @ApiProperty({
    type: StaleProjectDto,
    isArray: true,
    description:
      'Projects whose embeddingModel no longer matches the active embedding provider — retrieval will reject them until re-indexed',
  })
  staleProjects!: StaleProjectDto[];
}
