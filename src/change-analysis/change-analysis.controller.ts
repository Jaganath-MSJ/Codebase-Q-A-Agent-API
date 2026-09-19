import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { ChangeAnalysisRecord } from '../db/schema';
import { ChangeAnalysisService } from './change-analysis.service';
import {
  ChangeAnalysisDto,
  ChangeAnalysisGenerateResponseDto,
  ChangeAnalysisStatusDto,
} from '../contracts';

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
  @ApiOkResponse({ type: ChangeAnalysisStatusDto })
  async get(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ChangeAnalysisStatusDto> {
    // Always 200 with a status envelope — no 404 for "not yet",
    // so the client can tell 'generating' (keep polling) from 'absent' (stop).
    const { analysis, status } =
      await this.changeAnalysisService.getAnalysisStatus(id);
    return {
      status,
      analysis: analysis ? toChangeAnalysisDto(analysis) : null,
    };
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: ChangeAnalysisGenerateResponseDto })
  regenerate(
    @Param('id', ParseUUIDPipe) id: string,
  ): ChangeAnalysisGenerateResponseDto {
    // Fire-and-forget, same reasoning as TourController.regenerate — a real
    // analysis needs a git fetch plus retrieval plus a model call, too long
    // to hold the HTTP request open for. Errors are caught and logged inside the service.
    this.changeAnalysisService.generate(id, true).catch((err) => {
      this.logger.error(
        `Change analysis regeneration failed for project ${id}: ${String(err)}`,
      );
    });
    return { status: 'generating' };
  }
}
