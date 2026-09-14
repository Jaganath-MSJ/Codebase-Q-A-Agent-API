import { Body, Controller, Post } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RetrievalService } from './retrieval.service';
import type { ScoredChunk } from './vector.retriever';
import { SearchRequestDto, ScoredChunkDto } from '../contracts';

function toScoredChunkDto(chunk: ScoredChunk): ScoredChunkDto {
  return {
    chunkId: chunk.chunkId,
    path: chunk.path,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: chunk.content,
    symbol: chunk.symbol,
    score: chunk.score,
  };
}

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly retrievalService: RetrievalService) {}

  @Post()
  @ApiOkResponse({ type: ScoredChunkDto, isArray: true })
  async search(@Body() dto: SearchRequestDto): Promise<ScoredChunkDto[]> {
    const chunks = await this.retrievalService.search(
      dto.projectId,
      dto.query,
      dto.mode,
      dto.k,
    );
    return chunks.map(toScoredChunkDto);
  }
}
