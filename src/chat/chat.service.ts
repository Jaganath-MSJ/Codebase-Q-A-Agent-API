import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { RetrievalService } from '../retrieval/retrieval.service';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import { ConversationsRepository } from '../db/repositories/conversations.repository';
import { MessagesRepository } from '../db/repositories/messages.repository';
import { CitationsRepository } from '../db/repositories/citations.repository';
import type { ConversationRow, MessageRow, CitationRow, NewCitationRow } from '../db/schema';
import { CHAT_PROVIDER_TOKEN } from '../llm/llm.module';
import type { ChatProvider, ChatUsage } from '../llm/chat-provider.interface';
import {
  AGENTIC_SYSTEM_PROMPT,
  buildCondensationPrompt,
  buildSummaryPrompt,
  buildUserPrompt,
  SYSTEM_PROMPT,
  type EvidenceBlock,
} from './prompt.builder';
import { parseCitations, type Citation } from '../common/citation-parser';
import { evictedExchanges, recentWindow, toExchanges, truncateAnswer, type Exchange } from './conversation-context';
import { runAgentLoop } from './agent.loop';
import type { EvidenceEntry } from './evidence-ledger';
import { ToolRegistry } from '../tools/tool.registry';

const TOP_K = 10;
const TITLE_MAX_LENGTH = 80;
const FLUSH_INTERVAL_MS = 400;
const CONDENSATION_WINDOW = 2;
const GENERATION_WINDOW = 3;
const SUMMARY_TRIGGER_EXCHANGES = 6;

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
  | {
      type: 'message_created';
      data: { userMessageId: string; assistantMessageId: string; resolvedMode?: 'fast' | 'thorough' };
    }
  | { type: 'status'; data: { stage: 'condensing' | 'retrieving' | 'generating' } }
  | { type: 'sources'; data: { sources: SourceRef[] } }
  | { type: 'token'; data: { delta: string } }
  | { type: 'tool'; data: { name: string; args: unknown } }
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
    private readonly toolRegistry: ToolRegistry,
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
   * Streams one turn of the conversation (RAG/"Fast" path) as a sequence of
   * SSE-ready events. The assistant row is created 'pending' before any
   * retrieval or generation happens, so a client that disconnects mid-answer
   * leaves a recoverable partial row ('streaming' + whatever content was
   * flushed) rather than nothing at all — the caller aborts `signal` on
   * disconnect. The actual generation is `generateRagAnswer`, shared with
   * `streamAgenticMessage`'s budget-exhaustion fallback.
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

    const priorExchanges = await this.computePriorExchanges(conversationId);
    yield* this.generateRagAnswer(conversation, userMessage, assistantMessage, question, priorExchanges, signal);
  }

  /**
   * Runs the Phase 7 agent loop instead of RAG retrieval: no condensation, no
   * upfront `search` — the model fetches its own evidence via tool calls, and
   * every concrete region it observes (a `search_code` snippet, a `read_file`
   * range) becomes a numbered evidence-ledger entry. Citations are parsed and
   * persisted exactly like the RAG path, just sourced from the ledger instead
   * of a retrieval pass.
   *
   * On budget exhaustion, falls back to `generateRagAnswer` on the SAME
   * assistant row rather than erroring or apologizing — a slightly worse
   * answer beats no answer, and the exhausted trajectory's `tool_trace` is
   * still preserved for debugging even though the final content is RAG's.
   */
  async *streamAgenticMessage(
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
    const startedAt = Date.now();
    try {
      yield { type: 'status', data: { stage: 'generating' } };
      await this.messagesRepository.markStreaming(assistantMessage.id);

      let usage: ChatUsage = {};
      let trace: unknown[] = [];
      let stopReason: string = 'stop';
      let evidence: EvidenceEntry[] = [];
      let lastFlushAt = startedAt;

      for await (const event of runAgentLoop(
        this.chatProvider,
        this.toolRegistry,
        conversation.projectId,
        AGENTIC_SYSTEM_PROMPT,
        question,
        signal,
      )) {
        if (event.type === 'text') {
          buffer += event.delta;
          yield { type: 'token', data: { delta: event.delta } };
          if (Date.now() - lastFlushAt >= FLUSH_INTERVAL_MS) {
            await this.messagesRepository.updateContent(assistantMessage.id, buffer);
            lastFlushAt = Date.now();
          }
        } else if (event.type === 'tool_call') {
          yield { type: 'tool', data: { name: event.name, args: event.args } };
        } else if (event.type === 'done') {
          usage = event.usage;
          trace = event.trace;
          stopReason = event.stopReason;
          evidence = event.evidence;
        }
      }

      if (signal.aborted) {
        await this.messagesRepository.updateContent(assistantMessage.id, buffer);
        return;
      }

      if (stopReason === 'budget_exhausted') {
        // Graceful degradation (docs/phases/phase-7-agentic-search.md §2): the
        // exhausted trajectory's own partial text is discarded in favor of a
        // complete RAG answer on the same row — but its `tool_trace` is worth
        // keeping, so `generateRagAnswer` is told about it explicitly.
        const priorExchanges = await this.computePriorExchanges(conversationId);
        yield* this.generateRagAnswer(
          conversation,
          userMessage,
          assistantMessage,
          question,
          priorExchanges,
          signal,
          trace,
        );
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
        toolTrace: trace,
      });

      // Every ledger entry gets a row, cited or not — same "Sources panel
      // shows what got ignored" guarantee as the RAG path, just sourced from
      // tool calls instead of an upfront retrieval pass. No chunkId/score:
      // a read_file range has no backing chunk row at all, and a search_code
      // hit's chunk metadata isn't needed for the citation to be clickable.
      const citedMarkers = new Set(citations.map((c) => c.marker));
      const citationRows: NewCitationRow[] = evidence.map((e) => ({
        messageId: assistantMessage.id,
        marker: e.marker,
        chunkId: null,
        filePath: e.path,
        startLine: e.startLine,
        endLine: e.endLine,
        contentHash: null,
        score: null,
        retrievalRank: null,
        used: citedMarkers.has(e.marker),
      }));
      await this.citationsRepository.insertMany(citationRows);

      yield { type: 'done', data: { messageId: assistantMessage.id, citations, usage, latencyMs } };

      try {
        if (!conversation.title) {
          await this.conversationsRepository.setTitle(conversationId, question.slice(0, TITLE_MAX_LENGTH));
        }
        await this.conversationsRepository.touch(conversationId);
      } catch {
        // ignore — title/updatedAt bookkeeping is cosmetic, not correctness-critical
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

  /**
   * The RAG turn body — condense → retrieve → build prompt → stream →
   * parse citations → persist → bookkeeping — on an assistant row that
   * already exists. Shared by `streamMessage` (the normal Fast path) and by
   * `streamAgenticMessage`'s budget-exhaustion fallback, so a fallback never
   * creates a second pair of rows for one turn. Owns its own error/abort
   * handling so either caller can simply `yield*` it.
   */
  private async *generateRagAnswer(
    conversation: ConversationRow,
    userMessage: MessageRow,
    assistantMessage: MessageRow,
    question: string,
    priorExchanges: Exchange[],
    signal: AbortSignal,
    toolTrace?: unknown[],
  ): AsyncGenerator<ChatSseEvent> {
    let buffer = '';
    try {
      const project = await this.projectsRepository.findById(conversation.projectId);

      let retrievalQuery = question;
      if (priorExchanges.length > 0) {
        yield { type: 'status', data: { stage: 'condensing' } };
        const condensationWindow = recentWindow(priorExchanges, CONDENSATION_WINDOW).map(
          toPromptExchange,
        );
        const { system, user } = buildCondensationPrompt(condensationWindow, question);
        const condensed = await this.chatProvider.complete({ system, user }, signal);
        if (signal.aborted) return;
        if (condensed.text.trim()) retrievalQuery = condensed.text.trim();
      }
      await this.messagesRepository.setRetrievalQuery(assistantMessage.id, retrievalQuery);

      yield { type: 'status', data: { stage: 'retrieving' } };
      const scoredChunks = await this.retrievalService.search(
        conversation.projectId,
        retrievalQuery,
        'hybrid',
        TOP_K,
      );
      if (signal.aborted) return;

      const evidence: EvidenceBlock[] = scoredChunks.map((chunk) => ({
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
      }));

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

      // The model is shown the ORIGINAL question here, never the condensed
      // one — condensation is for retrieval only, and reads robotic otherwise.
      const generationWindow = recentWindow(priorExchanges, GENERATION_WINDOW).map(toPromptExchange);
      const user = buildUserPrompt(evidence, question, {
        overview: project?.overview,
        summary: conversation.summary,
        recentExchanges: generationWindow,
      });

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
        toolTrace: toolTrace ?? null,
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
          await this.conversationsRepository.setTitle(conversation.id, question.slice(0, TITLE_MAX_LENGTH));
        }
        await this.conversationsRepository.touch(conversation.id);
        await this.maybeUpdateSummary(
          conversation,
          priorExchanges,
          {
            userMessageId: userMessage.id,
            assistantMessageId: assistantMessage.id,
            question,
            answer: buffer,
            answerStatus: 'complete',
          },
          signal,
        );
      } catch {
        // ignore — title/updatedAt/summary are cosmetic, not correctness-critical
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

  /**
   * The pair just inserted for this turn is always the newest two rows —
   * everything before them is prior turns to condense/summarize against.
   * Only a successfully completed turn is trustworthy context.
   */
  private async computePriorExchanges(conversationId: string): Promise<Exchange[]> {
    const allMessages = await this.messagesRepository.findAllByConversation(conversationId);
    return toExchanges(allMessages.slice(0, -2)).filter((ex) => ex.answerStatus === 'complete');
  }

  /**
   * Once a conversation passes six exchanges, folds everything that just
   * fell out of the fixed recent window into `conversations.summary` — only
   * the newly-evicted turns, against the existing summary, never a full
   * re-summarization.
   */
  private async maybeUpdateSummary(
    conversation: ConversationRow,
    priorExchanges: Exchange[],
    currentExchange: Exchange,
    signal: AbortSignal,
  ): Promise<void> {
    const allExchanges = [...priorExchanges, currentExchange];
    if (allExchanges.length <= SUMMARY_TRIGGER_EXCHANGES) return;

    const evicted = evictedExchanges(
      allExchanges,
      GENERATION_WINDOW,
      conversation.summarizedThroughMsgId,
    );
    if (evicted.length === 0) return;

    const { system, user } = buildSummaryPrompt(conversation.summary, evicted.map(toPromptExchange));
    const summarized = await this.chatProvider.complete({ system, user }, signal);
    const newSummary = summarized.text.trim();
    if (!newSummary) return;

    const lastEvicted = evicted[evicted.length - 1]!;
    await this.conversationsRepository.updateSummary(
      conversation.id,
      newSummary,
      lastEvicted.assistantMessageId,
    );
  }

  private async requireConversation(id: string): Promise<ConversationRow> {
    const conversation = await this.conversationsRepository.findById(id);
    if (!conversation) throw new NotFoundException(`Conversation ${id} not found`);
    return conversation;
  }
}

function toPromptExchange(exchange: Exchange): { question: string; answer: string } {
  return { question: exchange.question, answer: truncateAnswer(exchange.answer) };
}
