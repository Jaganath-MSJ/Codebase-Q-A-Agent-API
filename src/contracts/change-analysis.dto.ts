import { ApiProperty } from '@nestjs/swagger';

export class ChangeAnalysisCitationDto {
  @ApiProperty({ description: '1-based marker as it appears in the summary, e.g. [1]' })
  marker!: number;

  @ApiProperty()
  path!: string;

  @ApiProperty()
  startLine!: number;

  @ApiProperty()
  endLine!: number;
}

export class ChangeAnalysisDto {
  @ApiProperty()
  commitHash!: string;

  @ApiProperty()
  commitMessage!: string;

  @ApiProperty({ type: String, isArray: true })
  changedFiles!: string[];

  @ApiProperty()
  summary!: string;

  @ApiProperty({ type: ChangeAnalysisCitationDto, isArray: true })
  citations!: ChangeAnalysisCitationDto[];

  @ApiProperty()
  generatedAt!: string;
}

export class ChangeAnalysisGenerateResponseDto {
  @ApiProperty({ enum: ['generating'] })
  status!: 'generating';
}
