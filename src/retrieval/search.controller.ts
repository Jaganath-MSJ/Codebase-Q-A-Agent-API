import { Body, Controller, Post } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RetrievalService } from './retrieval.service';
import { SearchRequestDto, ScoredChunkDto } from '../contracts';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly retrievalService: RetrievalService) {}

  @Post()
  @ApiOkResponse({ type: ScoredChunkDto, isArray: true })
  async search(@Body() dto: SearchRequestDto): Promise<ScoredChunkDto[]> {
    return this.retrievalService.search(dto.projectId, dto.query);
  }
}
