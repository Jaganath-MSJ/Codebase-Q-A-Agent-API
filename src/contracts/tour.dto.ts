import { ApiProperty } from '@nestjs/swagger';

export class TourCitationDto {
  @ApiProperty({ description: '1-based marker as it appears in the section body, e.g. [1]' })
  marker!: number;

  @ApiProperty()
  path!: string;

  @ApiProperty()
  startLine!: number;

  @ApiProperty()
  endLine!: number;
}

export class TourSectionDto {
  @ApiProperty()
  title!: string;

  @ApiProperty()
  body!: string;

  @ApiProperty({ type: TourCitationDto, isArray: true })
  citations!: TourCitationDto[];
}

export class TourDto {
  @ApiProperty()
  summary!: string;

  @ApiProperty({ type: TourSectionDto, isArray: true })
  sections!: TourSectionDto[];

  @ApiProperty()
  generatedAt!: string;
}

export type TourStatus = 'ready' | 'generating' | 'absent';

export class TourStatusDto {
  @ApiProperty({
    enum: ['ready', 'generating', 'absent'],
    description:
      "Whether a tour is being produced: 'ready' (a fresh tour is present), 'generating' (one is in flight — keep polling), 'absent' (nothing is generating and none is coming — stop polling).",
  })
  status!: TourStatus;

  @ApiProperty({
    type: TourDto,
    nullable: true,
    description: 'The tour, if one has been generated (may be a stale one while a newer is generating); null otherwise.',
  })
  tour!: TourDto | null;
}

export class TourGenerateResponseDto {
  @ApiProperty({ enum: ['generating'] })
  status!: 'generating';
}
