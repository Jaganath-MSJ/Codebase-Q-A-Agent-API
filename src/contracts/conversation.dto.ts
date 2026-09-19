import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

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
  @ApiProperty({
    type: String,
    isArray: true,
    description: 'At least 2 distinct, already-indexed project ids',
  })
  @IsArray()
  @ArrayMinSize(2)
  @IsUUID('4', { each: true })
  projectIds!: string[];
}

export class CitationDto {
  @ApiProperty({
    description: '1-based marker as it appears in the answer text, e.g. [1]',
  })
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
    description:
      'Which project this came from — only set for a multi-project conversation',
  })
  projectId?: string | null;

  @ApiProperty({ nullable: true, type: Number })
  score!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  retrievalRank!: number | null;

  @ApiProperty({
    description: 'Whether the model actually cited this retrieved chunk',
  })
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

  @ApiProperty({
    type: CitationDto,
    isArray: true,
    description: 'Every retrieved chunk, cited or not',
  })
  citations!: CitationDto[];

  @ApiProperty()
  createdAt!: string;
}

/**
 * Length ceiling for a single question — see DEF-033.
 *
 * ~1,000 tokens at the usual four-characters-per-token approximation. Chosen to
 * be generous for what a person actually types — a paragraph, a pasted stack
 * trace, a short function — while staying a small fraction of the ~11k-token
 * RAG prompt the question is embedded in, so the question can never be the
 * thing that pushes a turn over a provider's per-request ceiling.
 *
 * Deliberately far below Express's default 100 KB body limit, which was the
 * only ceiling before this and is a transport bound, not a product one.
 */
export const QUESTION_MAX_LENGTH = 4_000;

export class PostMessageDto {
  @ApiProperty({
    description: 'Question in plain English',
    maxLength: QUESTION_MAX_LENGTH,
  })
  @IsString()
  // DEF-025. `@IsNotEmpty()` alone rejects '' but passes '   ', so a
  // whitespace-only question ran the whole pipeline — condense, retrieve,
  // generate — against a free tier, and the model dutifully answered that no
  // question had been asked. Trimming before the check closes that and
  // normalises the rest: a question pasted with a trailing newline is the same
  // question, so it should hash to the same LLM cache key and reach the prompt
  // builder identically. Guarded on `typeof` because a non-string still has to
  // reach `@IsString()` to be reported as a type error rather than a crash.
  // `value` is annotated because class-transformer types it as `any`, and
  // returning that trips @typescript-eslint/no-unsafe-return.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsNotEmpty()
  // DEF-033. The other half of DEF-019's root cause, which was fixed on the
  // project name and missed here: the trim landed on both DTOs, the ceiling on
  // only one. Without it the sole limit was the 100 KB body, so a ~100 KB
  // question ran the whole pipeline — condense, retrieve, generate — against a
  // 900/day free tier. Bounded after the trim, so trailing whitespace cannot
  // consume the allowance.
  @MaxLength(QUESTION_MAX_LENGTH)
  question!: string;

  @ApiPropertyOptional({
    enum: ['auto', 'fast', 'thorough'],
    description:
      '"fast" (RAG) or "thorough" (the agent loop) forces that mode; "auto" or omitted lets the heuristic router decide from the question text.',
  })
  @IsOptional()
  @IsIn(['auto', 'fast', 'thorough'])
  mode?: 'auto' | 'fast' | 'thorough';
}
