import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ChatService, type ChatSseEvent, type MessageWithCitations } from './chat.service';
import { classifyMode } from './mode-router';
import { ConversationProjectsRepository } from '../db/repositories/conversation-projects.repository';
import {
  CitationDto,
  ConversationDto,
  CreateMultiConversationDto,
  MessageDto,
  PostMessageDto,
} from '../contracts';
import type { ConversationRow, CitationRow } from '../db/schema';

export function toConversationDto(row: ConversationRow, projectIds?: string[]): ConversationDto {
  return {
    id: row.id,
    projectId: row.projectId,
    // Omitted entirely (not even `undefined` sent as null) for an ordinary
    // single-project conversation — see the DTO's own doc comment.
    ...(projectIds && projectIds.length >= 2 ? { projectIds } : {}),
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function slugify(title: string | null): string | null {
  if (!title) return null;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || null;
}

function toCitationDto(row: CitationRow): CitationDto {
  return {
    marker: row.marker,
    path: row.filePath,
    startLine: row.startLine,
    endLine: row.endLine,
    projectId: row.projectId,
    score: row.score,
    retrievalRank: row.retrievalRank,
    used: row.used,
  };
}

export function toMessageDto(row: MessageWithCitations): MessageDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role as 'user' | 'assistant',
    content: row.content,
    status: row.status as 'pending' | 'streaming' | 'complete' | 'error',
    error: row.error,
    citations: row.citations.map(toCitationDto),
    createdAt: row.createdAt.toISOString(),
  };
}

@ApiTags('chat')
@Controller()
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly conversationProjectsRepository: ConversationProjectsRepository,
  ) {}

  @Post('projects/:projectId/conversations')
  @HttpCode(HttpStatus.CREATED)
  @ApiCreatedResponse({ type: ConversationDto })
  async createConversation(@Param('projectId', ParseUUIDPipe) projectId: string): Promise<ConversationDto> {
    const row = await this.chatService.createConversation(projectId);
    return toConversationDto(row);
  }

  /** Fast/RAG mode only — see `ChatService.createMultiProjectConversation`'s doc comment. */
  @Post('conversations/multi')
  @HttpCode(HttpStatus.CREATED)
  @ApiCreatedResponse({ type: ConversationDto })
  async createMultiConversation(@Body() dto: CreateMultiConversationDto): Promise<ConversationDto> {
    const row = await this.chatService.createMultiProjectConversation(dto.projectIds);
    return toConversationDto(row, dto.projectIds);
  }

  @Get('projects/:projectId/conversations')
  @ApiOkResponse({ type: ConversationDto, isArray: true })
  async listConversations(@Param('projectId', ParseUUIDPipe) projectId: string): Promise<ConversationDto[]> {
    const rows = await this.chatService.listConversations(projectId);
    const projectIdsByConversation = await this.conversationProjectsRepository.findProjectIdsForConversations(
      rows.map((r) => r.id),
    );
    return rows.map((row) => toConversationDto(row, projectIdsByConversation.get(row.id)));
  }

  @Get('conversations/:id/messages')
  @ApiOkResponse({ type: MessageDto, isArray: true })
  async listMessages(@Param('id', ParseUUIDPipe) id: string): Promise<MessageDto[]> {
    const rows = await this.chatService.listMessages(id);
    return rows.map(toMessageDto);
  }

  /**
   * A plain Markdown attachment, not JSON — the point is a file you can drop
   * straight into a PR or design doc, so `Content-Disposition` (not a typed
   * body) is what matters here, same pattern as the SSE endpoint above.
   */
  @Get('conversations/:id/export')
  @ApiOkResponse({ description: 'text/markdown attachment of the full conversation transcript' })
  async exportConversation(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const { title, markdown } = await this.chatService.exportConversationMarkdown(id);
    const filename = `conversation-${slugify(title) ?? id}.md`;

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(markdown);
  }

  /**
   * `text/event-stream`, not a typed JSON body — see the event sequence in
   * docs/phases/phase-3-conversation.md. Headers are only written once the
   * conversation is confirmed to exist, so a bad id still gets a normal JSON
   * 404 from Nest's exception filter instead of a malformed stream.
   *
   * Mode routing lives here, not in `ChatService` — the service exposes two
   * plain generation strategies (Fast/Thorough), and this is the one place
   * that decides which one a given request actually gets, whether from an
   * explicit `mode` or the heuristic router on "auto". A multi-project
   * conversation is always forced to Fast here, regardless of what was
   * requested — Phase 7's tool executors are single-projectId-scoped
   * throughout, so Thorough mode has no meaningful multi-project behavior
   * to fall back to yet.
   */
  @Post('conversations/:id/messages')
  @ApiOkResponse({
    description: 'text/event-stream: message_created, status, sources, token, done, error',
  })
  async postMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PostMessageDto,
    @Res() res: Response,
  ): Promise<void> {
    const abortController = new AbortController();
    res.on('close', () => abortController.abort());

    const requestedMode = dto.mode ?? 'auto';
    let resolvedMode = requestedMode === 'auto' ? classifyMode(dto.question) : requestedMode;
    if (resolvedMode === 'thorough' && (await this.chatService.isMultiProject(id))) {
      resolvedMode = 'fast';
    }

    const events =
      resolvedMode === 'thorough'
        ? this.chatService.streamAgenticMessage(id, dto.question, abortController.signal)
        : this.chatService.streamMessage(id, dto.question, abortController.signal);
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

    // Tags the very first event with what the router actually decided, so
    // the UI can show "Auto → Thorough" without re-running the heuristic.
    if (!first.done) {
      const value: ChatSseEvent = first.value;
      write(
        value.type === 'message_created'
          ? { ...value, data: { ...value.data, resolvedMode } }
          : value,
      );
    }
    for await (const event of events) {
      write(event);
    }

    res.end();
  }
}
