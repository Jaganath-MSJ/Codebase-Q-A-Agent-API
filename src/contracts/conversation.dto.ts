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

  @ApiProperty()
  createdAt!: string;
}

export class PostMessageDto {
  @ApiProperty({ description: 'Question in plain English' })
  @IsString()
  @IsNotEmpty()
  question!: string;
}
