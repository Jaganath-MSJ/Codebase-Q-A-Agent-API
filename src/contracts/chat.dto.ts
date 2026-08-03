import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class AskDto {
  @ApiProperty({ description: 'Project to ask about' })
  @IsUUID()
  projectId!: string;

  @ApiProperty({ description: 'Question in plain English' })
  @IsString()
  @IsNotEmpty()
  question!: string;
}

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

export class AskResponseDto {
  @ApiProperty()
  answer!: string;

  @ApiProperty({ type: CitationDto, isArray: true })
  citations!: CitationDto[];
}
