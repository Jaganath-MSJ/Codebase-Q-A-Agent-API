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

export class TourGenerateResponseDto {
  @ApiProperty({ enum: ['generating'] })
  status!: 'generating';
}
