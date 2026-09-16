import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
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

  // The only POST in the codebase that was missing an explicit @HttpCode, so
  // Nest's @Post() default made it answer 201 while @ApiOkResponse published
  // 200 (DEF-010). Corrected towards the spec rather than the other way: a
  // search creates nothing, so 200 is also the truer status — and the already
  // generated web/src/api/schema.d.ts declares 200, so it needs no regeneration.
  @Post()
  @HttpCode(HttpStatus.OK)
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
