import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { RetrievalService } from '../retrieval/retrieval.service';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import { ConversationsRepository } from '../db/repositories/conversations.repository';
import { MessagesRepository } from '../db/repositories/messages.repository';
import type { ConversationRow, MessageRow } from '../db/schema';
import { CHAT_PROVIDER_TOKEN } from '../llm/llm.module';
import type { ChatProvider, ChatUsage } from '../llm/chat-provider.interface';
import { buildUserPrompt, SYSTEM_PROMPT, type EvidenceBlock } from './prompt.builder';
import { parseCitations, type Citation } from './citation.parser';

const TOP_K = 10;
const TITLE_MAX_LENGTH = 80;
const FLUSH_INTERVAL_MS = 400;

export type ChatSseEvent =
  | { type: 'message_created'; data: { userMessageId: string; assistantMessageId: string } }
  | { type: 'status'; data: { stage: 'retrieving' | 'generating' } }
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

  async listMessages(conversationId: string): Promise<MessageRow[]> {
    await this.requireConversation(conversationId);
    return this.messagesRepository.findAllByConversation(conversationId);
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
