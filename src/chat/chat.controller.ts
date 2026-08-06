import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ChatService } from './chat.service';
import { ConversationDto, MessageDto, PostMessageDto } from '../contracts';
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
    status: row.status as 'pending' | 'streaming' | 'complete' | 'error',
    error: row.error,
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

  /**
   * `text/event-stream`, not a typed JSON body — see the event sequence in
   * docs/phases/phase-3-conversation.md. Headers are only written once the
   * conversation is confirmed to exist, so a bad id still gets a normal JSON
   * 404 from Nest's exception filter instead of a malformed stream.
   */
  @Post('conversations/:id/messages')
  @ApiOkResponse({ description: 'text/event-stream: message_created, status, token, done, error' })
  async postMessage(
    @Param('id') id: string,
    @Body() dto: PostMessageDto,
    @Res() res: Response,
  ): Promise<void> {
    const abortController = new AbortController();
    res.on('close', () => abortController.abort());

    const events = this.chatService.streamMessage(id, dto.question, abortController.signal);
    const first = await events.next();

    res.writeHead(HttpStatus.OK, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const write = (event: { type: string; data: unknown }) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    };

    if (!first.done) write(first.value);
    for await (const event of events) {
      write(event);
    }

    res.end();
  }
}
