import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class ConversationDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  projectId!: string;

  @ApiProperty({ nullable: true, type: String })
  title!: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
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
}
