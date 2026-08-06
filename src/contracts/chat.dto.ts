import { ApiProperty } from '@nestjs/swagger';

export class CitationDto {
  @ApiProperty({ description: '1-based marker as it appears in the answer text, e.g. [1]' })
  marker!: number;

  @ApiProperty()
  path!: string;

  @ApiProperty()
  startLine!: number;

  @ApiProperty()
  endLine!: number;

  @ApiProperty()
  content!: string;
}
