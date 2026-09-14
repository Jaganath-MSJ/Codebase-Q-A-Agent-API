import { ApiProperty } from '@nestjs/swagger';

export class ChangeAnalysisCitationDto {
  @ApiProperty({
    description: '1-based marker as it appears in the summary, e.g. [1]',
  })
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

export type ChangeAnalysisStatus = 'ready' | 'generating' | 'absent';

export class ChangeAnalysisStatusDto {
  @ApiProperty({
    enum: ['ready', 'generating', 'absent'],
    description:
      "Whether an analysis is being produced: 'ready' (a fresh analysis is present), 'generating' (one is in flight — keep polling), 'absent' (nothing is generating and none is coming, e.g. a non-git project — stop polling).",
  })
  status!: ChangeAnalysisStatus;

  @ApiProperty({
    type: ChangeAnalysisDto,
    nullable: true,
    description:
      'The analysis, if one has been generated (may be a stale one while a newer is generating); null otherwise.',
  })
  analysis!: ChangeAnalysisDto | null;
}

export class ChangeAnalysisGenerateResponseDto {
  @ApiProperty({ enum: ['generating'] })
  status!: 'generating';
}
