import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ChatService } from './chat.service';
import {
  ConversationDto,
  MessageDto,
  PostMessageDto,
  PostMessageResponseDto,
} from '../contracts';
import type { ConversationRow, MessageRow } from '../db/schema';

export function toConversationDto(row: ConversationRow): ConversationDto {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toMessageDto(row: MessageRow): MessageDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role as 'user' | 'assistant',
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

@ApiTags('chat')
@Controller()
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('projects/:projectId/conversations')
  @HttpCode(HttpStatus.CREATED)
  @ApiCreatedResponse({ type: ConversationDto })
  async createConversation(@Param('projectId') projectId: string): Promise<ConversationDto> {
    const row = await this.chatService.createConversation(projectId);
    return toConversationDto(row);
  }

  @Get('projects/:projectId/conversations')
  @ApiOkResponse({ type: ConversationDto, isArray: true })
  async listConversations(@Param('projectId') projectId: string): Promise<ConversationDto[]> {
    const rows = await this.chatService.listConversations(projectId);
    return rows.map(toConversationDto);
  }

  @Get('conversations/:id/messages')
  @ApiOkResponse({ type: MessageDto, isArray: true })
  async listMessages(@Param('id') id: string): Promise<MessageDto[]> {
    const rows = await this.chatService.listMessages(id);
    return rows.map(toMessageDto);
  }

  @Post('conversations/:id/messages')
  @ApiOkResponse({ type: PostMessageResponseDto })
  async postMessage(
    @Param('id') id: string,
    @Body() dto: PostMessageDto,
  ): Promise<PostMessageResponseDto> {
    const result = await this.chatService.postMessage(id, dto.question);
    return {
      userMessage: toMessageDto(result.userMessage),
      assistantMessage: toMessageDto(result.assistantMessage),
      citations: result.citations,
    };
  }
}
