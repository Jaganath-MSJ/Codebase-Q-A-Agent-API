import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class ConversationDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: "The conversation's original/primary project" })
  projectId!: string;

  @ApiPropertyOptional({
    type: String,
    isArray: true,
    description:
      'Only present for a multi-project conversation (2+ ids) — omitted entirely for an ordinary single-project one.',
  })
  projectIds?: string[];

  @ApiProperty({ nullable: true, type: String })
  title!: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class CreateMultiConversationDto {
  @ApiProperty({ type: String, isArray: true, description: 'At least 2 distinct, already-indexed project ids' })
  @IsArray()
  @ArrayMinSize(2)
  @IsUUID('4', { each: true })
  projectIds!: string[];
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

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Which project this came from — only set for a multi-project conversation',
  })
  projectId?: string | null;

  @ApiProperty({ nullable: true, type: Number })
  score!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  retrievalRank!: number | null;

  @ApiProperty({ description: 'Whether the model actually cited this retrieved chunk' })
  used!: boolean;
}

export class MessageDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  conversationId!: string;

  @ApiProperty({ enum: ['user', 'assistant'] })
  role!: 'user' | 'assistant';

  @ApiProperty()
  content!: string;

  @ApiProperty({ enum: ['pending', 'streaming', 'complete', 'error'] })
  status!: 'pending' | 'streaming' | 'complete' | 'error';

  @ApiProperty({ nullable: true, type: String })
  error!: string | null;

  @ApiProperty({ type: CitationDto, isArray: true, description: 'Every retrieved chunk, cited or not' })
  citations!: CitationDto[];

  @ApiProperty()
  createdAt!: string;
}

export class PostMessageDto {
  @ApiProperty({ description: 'Question in plain English' })
  @IsString()
  @IsNotEmpty()
  question!: string;

  @ApiPropertyOptional({
    enum: ['auto', 'fast', 'thorough'],
    description:
      '"fast" (RAG) or "thorough" (the Phase 7 agent loop) forces that mode; "auto" or omitted lets the heuristic router decide from the question text.',
  })
  @IsOptional()
  @IsIn(['auto', 'fast', 'thorough'])
  mode?: 'auto' | 'fast' | 'thorough';
}
