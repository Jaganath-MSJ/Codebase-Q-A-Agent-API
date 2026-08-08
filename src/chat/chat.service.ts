import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { RetrievalService } from '../retrieval/retrieval.service';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import { ConversationsRepository } from '../db/repositories/conversations.repository';
import { MessagesRepository } from '../db/repositories/messages.repository';
import { CitationsRepository } from '../db/repositories/citations.repository';
import type { ConversationRow, MessageRow, CitationRow, NewCitationRow } from '../db/schema';
import { CHAT_PROVIDER_TOKEN } from '../llm/llm.module';
import type { ChatProvider, ChatUsage } from '../llm/chat-provider.interface';
import { buildUserPrompt, SYSTEM_PROMPT, type EvidenceBlock } from './prompt.builder';
import { parseCitations, type Citation } from './citation.parser';

const TOP_K = 10;
const TITLE_MAX_LENGTH = 80;
const FLUSH_INTERVAL_MS = 400;

export interface SourceRef {
  marker: number;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
}

export interface MessageWithCitations extends MessageRow {
  citations: CitationRow[];
}

export type ChatSseEvent =
  | { type: 'message_created'; data: { userMessageId: string; assistantMessageId: string } }
  | { type: 'status'; data: { stage: 'retrieving' | 'generating' } }
  | { type: 'sources'; data: { sources: SourceRef[] } }
  | { type: 'token'; data: { delta: string } }
  | {
      type: 'done';
      data: { messageId: string; citations: Citation[]; usage: ChatUsage; latencyMs: number };
    }
  | { type: 'error'; data: { messageId: string; message: string } };

@Injectable()
export class ChatService {
  constructor(
    private readonly retrievalService: RetrievalService,
    private readonly projectsRepository: ProjectsRepository,
    private readonly conversationsRepository: ConversationsRepository,
    private readonly messagesRepository: MessagesRepository,
    private readonly citationsRepository: CitationsRepository,
    @Inject(CHAT_PROVIDER_TOKEN) private readonly chatProvider: ChatProvider,
  ) {}

  async createConversation(projectId: string): Promise<ConversationRow> {
    const project = await this.projectsRepository.findById(projectId);
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    return this.conversationsRepository.create({ projectId, title: null });
  }

  async listConversations(projectId: string): Promise<ConversationRow[]> {
    return this.conversationsRepository.findAllByProject(projectId);
  }

  async listMessages(conversationId: string): Promise<MessageWithCitations[]> {
    await this.requireConversation(conversationId);
    const rows = await this.messagesRepository.findAllByConversation(conversationId);

    const citationRows = await this.citationsRepository.findAllByMessageIds(rows.map((r) => r.id));
    const byMessage = new Map<string, CitationRow[]>();
    for (const citation of citationRows) {
      const list = byMessage.get(citation.messageId);
      if (list) list.push(citation);
      else byMessage.set(citation.messageId, [citation]);
    }

    return rows.map((row) => ({ ...row, citations: byMessage.get(row.id) ?? [] }));
  }

  /**
   * Streams one turn of the conversation as a sequence of SSE-ready events.
   * The assistant row is created 'pending' before any retrieval or generation
   * happens, so a client that disconnects mid-answer leaves a recoverable
   * partial row ('streaming' + whatever content was flushed) rather than
   * nothing at all — the caller aborts `signal` on disconnect.
   */
  async *streamMessage(
    conversationId: string,
    question: string,
    signal: AbortSignal,
  ): AsyncGenerator<ChatSseEvent> {
    const conversation = await this.requireConversation(conversationId);
    const { userMessage, assistantMessage } = await this.messagesRepository.createTurn(
      conversationId,
      question,
    );

    yield {
      type: 'message_created',
      data: { userMessageId: userMessage.id, assistantMessageId: assistantMessage.id },
    };

    let buffer = '';
    try {
      yield { type: 'status', data: { stage: 'retrieving' } };
      const scoredChunks = await this.retrievalService.search(conversation.projectId, question, TOP_K);
      if (signal.aborted) return;

      const evidence: EvidenceBlock[] = scoredChunks.map((chunk) => ({
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
      }));
      const user = buildUserPrompt(evidence, question);

      // Emitted before the first token so `[1]` becomes a live chip the
      // instant it streams in, and so a slow first token has something to
      // show. Markers are 1-based positions in `scoredChunks`, matching how
      // `parseCitations` resolves `[n]` against the same-ordered `evidence`.
      yield {
        type: 'sources',
        data: {
          sources: scoredChunks.map((chunk, i) => ({
            marker: i + 1,
            path: chunk.path,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            score: chunk.score,
          })),
        },
      };

      yield { type: 'status', data: { stage: 'generating' } };
      await this.messagesRepository.markStreaming(assistantMessage.id);

      const startedAt = Date.now();
      let lastFlushAt = startedAt;
      let usage: ChatUsage = {};

      for await (const event of this.chatProvider.stream({ system: SYSTEM_PROMPT, user }, signal)) {
        if (event.type === 'text') {
          buffer += event.delta;
          yield { type: 'token', data: { delta: event.delta } };
          if (Date.now() - lastFlushAt >= FLUSH_INTERVAL_MS) {
            await this.messagesRepository.updateContent(assistantMessage.id, buffer);
            lastFlushAt = Date.now();
          }
        } else if (event.type === 'usage') {
          usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
        }
      }

      if (signal.aborted) {
        await this.messagesRepository.updateContent(assistantMessage.id, buffer);
        return;
      }

      const citations = parseCitations(buffer, evidence);
      const latencyMs = Date.now() - startedAt;
      const [providerName, ...modelParts] = this.chatProvider.id.split(':');

      await this.messagesRepository.completeAssistant(assistantMessage.id, {
        content: buffer,
        provider: providerName ?? this.chatProvider.id,
        model: modelParts.length > 0 ? modelParts.join(':') : null,
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        latencyMs,
      });

      // Every retrieved chunk gets a row, not just the cited ones — the
      // Sources panel's whole point is showing what got ignored.
      const citedMarkers = new Set(citations.map((c) => c.marker));
      const citationRows: NewCitationRow[] = scoredChunks.map((chunk, i) => {
        const marker = i + 1;
        return {
          messageId: assistantMessage.id,
          marker,
          chunkId: chunk.chunkId,
          filePath: chunk.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          contentHash: chunk.contentHash,
          score: chunk.score,
          retrievalRank: marker,
          used: citedMarkers.has(marker),
        };
      });
      await this.citationsRepository.insertMany(citationRows);

      yield { type: 'done', data: { messageId: assistantMessage.id, citations, usage, latencyMs } };

      // Best-effort bookkeeping — the turn above is already durably complete,
      // so a hiccup here must never flip status back to 'error'.
      try {
        if (!conversation.title) {
          await this.conversationsRepository.setTitle(conversationId, question.slice(0, TITLE_MAX_LENGTH));
        }
        await this.conversationsRepository.touch(conversationId);
      } catch {
        // ignore — title/updatedAt are cosmetic, not correctness-critical
      }
    } catch (err) {
      if (signal.aborted) {
        await this.messagesRepository.updateContent(assistantMessage.id, buffer);
        return;
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      await this.messagesRepository.markError(assistantMessage.id, buffer, message);
      yield { type: 'error', data: { messageId: assistantMessage.id, message } };
    }
  }

  private async requireConversation(id: string): Promise<ConversationRow> {
    const conversation = await this.conversationsRepository.findById(id);
    if (!conversation) throw new NotFoundException(`Conversation ${id} not found`);
    return conversation;
  }
}
