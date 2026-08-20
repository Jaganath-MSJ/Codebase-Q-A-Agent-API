import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { ChangeAnalysisRecord } from '../db/schema';
import { ChangeAnalysisService } from './change-analysis.service';
import { ChangeAnalysisDto, ChangeAnalysisGenerateResponseDto } from '../contracts';

function toChangeAnalysisDto(record: ChangeAnalysisRecord): ChangeAnalysisDto {
  return {
    commitHash: record.commitHash,
    commitMessage: record.commitMessage,
    changedFiles: record.changedFiles,
    summary: record.summary,
    citations: record.citations,
    generatedAt: record.generatedAt,
  };
}

@ApiTags('change-analysis')
@Controller('projects/:id/changes')
export class ChangeAnalysisController {
  private readonly logger = new Logger(ChangeAnalysisController.name);

  constructor(private readonly changeAnalysisService: ChangeAnalysisService) {}

  @Get()
  @ApiOkResponse({ type: ChangeAnalysisDto })
  async get(@Param('id') id: string): Promise<ChangeAnalysisDto> {
    const analysis = await this.changeAnalysisService.getAnalysis(id);
    if (!analysis) throw new NotFoundException(`No change analysis generated yet for project ${id}`);
    return toChangeAnalysisDto(analysis);
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: ChangeAnalysisGenerateResponseDto })
  async regenerate(@Param('id') id: string): Promise<ChangeAnalysisGenerateResponseDto> {
    // Fire-and-forget, same reasoning as TourController.regenerate — a real
    // analysis needs a git fetch plus retrieval plus a model call, too long
    // to hold the HTTP request open for. Errors are caught and logged inside the service.
    this.changeAnalysisService.generate(id, true).catch((err) => {
      this.logger.error(`Change analysis regeneration failed for project ${id}: ${String(err)}`);
    });
    return { status: 'generating' };
  }
}
