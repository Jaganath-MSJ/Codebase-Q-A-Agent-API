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
import type { TourRecord } from '../db/schema';
import { TourService } from './tour.service';
import { TourDto, TourGenerateResponseDto } from '../contracts';

function toTourDto(record: TourRecord): TourDto {
  return { summary: record.summary, sections: record.sections, generatedAt: record.generatedAt };
}

@ApiTags('tour')
@Controller('projects/:id/tour')
export class TourController {
  private readonly logger = new Logger(TourController.name);

  constructor(private readonly tourService: TourService) {}

  @Get()
  @ApiOkResponse({ type: TourDto })
  async get(@Param('id') id: string): Promise<TourDto> {
    const tour = await this.tourService.getTour(id);
    if (!tour) throw new NotFoundException(`No tour generated yet for project ${id}`);
    return toTourDto(tour);
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: TourGenerateResponseDto })
  async regenerate(@Param('id') id: string): Promise<TourGenerateResponseDto> {
    // Fire-and-forget: a real tour takes 5-8 sequential model calls, too long
    // to hold an HTTP request open for — the client polls GET back until
    // `generatedAt` moves. Errors are caught and logged inside the service.
    this.tourService.generate(id, true).catch((err) => {
      this.logger.error(`Tour regeneration failed for project ${id}: ${String(err)}`);
    });
    return { status: 'generating' };
  }
}
