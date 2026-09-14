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
import type { TourRecord } from '../db/schema';
import { TourService } from './tour.service';
import { TourDto, TourGenerateResponseDto, TourStatusDto } from '../contracts';

function toTourDto(record: TourRecord): TourDto {
  return {
    summary: record.summary,
    sections: record.sections,
    generatedAt: record.generatedAt,
  };
}

@ApiTags('tour')
@Controller('projects/:id/tour')
export class TourController {
  private readonly logger = new Logger(TourController.name);

  constructor(private readonly tourService: TourService) {}

  @Get()
  @ApiOkResponse({ type: TourStatusDto })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<TourStatusDto> {
    // Always 200 with a status envelope (Phase 13.5) — no 404 for "not yet",
    // so the client can tell 'generating' (keep polling) from 'absent' (stop).
    const { tour, status } = await this.tourService.getTourStatus(id);
    return { status, tour: tour ? toTourDto(tour) : null };
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: TourGenerateResponseDto })
  regenerate(@Param('id', ParseUUIDPipe) id: string): TourGenerateResponseDto {
    // Fire-and-forget: a real tour takes 5-8 sequential model calls, too long
    // to hold an HTTP request open for — the client polls GET back until
    // `generatedAt` moves. Errors are caught and logged inside the service.
    this.tourService.generate(id, true).catch((err) => {
      this.logger.error(
        `Tour regeneration failed for project ${id}: ${String(err)}`,
      );
    });
    return { status: 'generating' };
  }
}
