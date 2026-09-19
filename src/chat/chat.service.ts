import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { RetrievalService } from '../retrieval/retrieval.service';
import type { ScoredChunk } from '../retrieval/vector.retriever';
import { reciprocalRankFusion, type RankedList } from '../retrieval/rrf';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import { ConversationsRepository } from '../db/repositories/conversations.repository';
import { ConversationProjectsRepository } from '../db/repositories/conversation-projects.repository';
import { MessagesRepository } from '../db/repositories/messages.repository';
import { CitationsRepository } from '../db/repositories/citations.repository';
import type {
  ConversationRow,
  MessageRow,
  CitationRow,
  NewCitationRow,
} from '../db/schema';
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
import { redactSecrets } from '../common/redact';
import { userFacingProviderMessage } from '../llm/provider-error';
import {
  buildConversationMarkdown,
  type ExportCitation,
  type ExportMessage,
} from '../common/conversation-markdown';
import {
  evictedExchanges,
  recentWindow,
  toExchanges,
  truncateAnswer,
  type Exchange,
} from './conversation-context';
import { runAgentLoop } from './agent.loop';
import type { EvidenceEntry } from './evidence-ledger';
import { ToolRegistry } from '../tools/tool.registry';

const TOP_K = 10;
const TITLE_MAX_LENGTH = 80;
const FLUSH_INTERVAL_MS = 400;
const CONDENSATION_WINDOW = 2;
const GENERATION_WINDOW = 3;
const SUMMARY_TRIGGER_EXCHANGES = 6;
// Output caps (tunable). Generation is generous — a full cited answer
// must fit; condense (a one-line standalone query) and summary (a rolling digest)
// are short by intent. NOTE: gemini-flash-latest counts its internal "thinking"
// tokens against maxOutputTokens (measured: a 256 cap left only ~11 output
// tokens), so the "small" caps sit above that overhead — dropping condense to
// ~256 silently empties the condensed query on Gemini.
const GENERATION_MAX_TOKENS = 2048;
const CONDENSE_MAX_TOKENS = 512;
const SUMMARY_MAX_TOKENS = 768;

export interface SourceRef {
  marker: number;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  // Only set for a multi-project conversation's sources — see
  // `ConversationProjectsRepository`'s doc comment for why an ordinary
  // single-project conversation never populates this.
  projectId?: string;
}

/** A retrieval result tagged with which project it came from — always set, even for a single-project search, so `generateRagAnswer` has one shape to work with regardless of how many projects a conversation spans. */
type ScoredChunkWithProject = ScoredChunk & { projectId: string };

export interface MessageWithCitations extends MessageRow {
  citations: CitationRow[];
}

export type ChatSseEvent =
  | {
      type: 'message_created';
      data: {
        userMessageId: string;
        assistantMessageId: string;
        resolvedMode?: 'fast' | 'thorough';
      };
    }
  | {
      type: 'status';
      data: { stage: 'condensing' | 'retrieving' | 'generating' };
    }
  | { type: 'sources'; data: { sources: SourceRef[] } }
  | { type: 'token'; data: { delta: string } }
  | { type: 'tool'; data: { name: string; args: unknown } }
  | {
      type: 'done';
      data: {
        messageId: string;
        citations: Citation[];
        usage: ChatUsage;
        latencyMs: number;
      };
    }
  | { type: 'error'; data: { messageId: string; message: string } };

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly retrievalService: RetrievalService,
    private readonly projectsRepository: ProjectsRepository,
    private readonly conversationsRepository: ConversationsRepository,
    private readonly conversationProjectsRepository: ConversationProjectsRepository,
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

  /**
   * A conversation spanning 2+ projects — Fast/RAG mode only (the tool
   * executors are single-projectId-scoped throughout, so Thorough mode stays
   * blocked for these; see `ChatController`'s mode-forcing). `projectId` on
   * the created row is the first id given, purely so every pre-existing
   * single-project code path that reads it (overview injection, Markdown
   * export) keeps behaving sensibly without needing to know this
   * conversation is unusual.
   */
  async createMultiProjectConversation(
    projectIds: string[],
  ): Promise<ConversationRow> {
    const distinctIds = [...new Set(projectIds)];
    if (distinctIds.length < 2) {
      throw new BadRequestException(
        'A multi-project conversation needs at least 2 distinct project ids',
      );
    }

    const projects = await Promise.all(
      distinctIds.map((id) => this.projectsRepository.findById(id)),
    );
    const missing = distinctIds.filter((_, i) => !projects[i]);
    if (missing.length > 0) {
      throw new NotFoundException(
        `Project(s) not found: ${missing.join(', ')}`,
      );
    }

    const conversation = await this.conversationsRepository.create({
      projectId: distinctIds[0]!,
      title: null,
    });
    await this.conversationProjectsRepository.addAll(
      conversation.id,
      distinctIds,
    );
    return conversation;
  }

  async listConversations(projectId: string): Promise<ConversationRow[]> {
    return this.conversationsRepository.findAllByProject(projectId);
  }

  async isMultiProject(conversationId: string): Promise<boolean> {
    const projectIds =
      await this.conversationProjectsRepository.findProjectIds(conversationId);
    return projectIds.length >= 2;
  }

  async listMessages(conversationId: string): Promise<MessageWithCitations[]> {
    await this.requireConversation(conversationId);
    const rows =
      await this.messagesRepository.findAllByConversation(conversationId);

    const citationRows = await this.citationsRepository.findAllByMessageIds(
      rows.map((r) => r.id),
    );
    const byMessage = new Map<string, CitationRow[]>();
    for (const citation of citationRows) {
      const list = byMessage.get(citation.messageId);
      if (list) list.push(citation);
      else byMessage.set(citation.messageId, [citation]);
    }

    return rows.map((row) => ({
      ...row,
      citations: byMessage.get(row.id) ?? [],
    }));
  }

  async exportConversationMarkdown(
    conversationId: string,
  ): Promise<{ title: string | null; markdown: string }> {
    const conversation = await this.requireConversation(conversationId);
    const project = await this.projectsRepository.findById(
      conversation.projectId,
    );
    if (!project)
      throw new NotFoundException(
        `Project ${conversation.projectId} not found`,
      );

    const messages = await this.listMessages(conversationId);
    const exportMessages: ExportMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
      citations: m.citations.map((c): ExportCitation => ({
        marker: c.marker,
        filePath: c.filePath,
        startLine: c.startLine,
        endLine: c.endLine,
        used: c.used,
      })),
    }));

    const markdown = buildConversationMarkdown({
      conversationTitle: conversation.title,
      project: {
        name: project.name,
        sourceKind: project.sourceKind,
        sourceRef: project.sourceRef,
        headRevision: project.headRevision,
      },
      messages: exportMessages,
    });

    return { title: conversation.title, markdown };
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
    const { userMessage, assistantMessage } =
      await this.messagesRepository.createTurn(conversationId, question);

    yield {
      type: 'message_created',
      data: {
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
      },
    };

    const priorExchanges = await this.computePriorExchanges(
      conversationId,
      conversation.summarizedThroughMsgId,
    );
    yield* this.generateRagAnswer(
      conversation,
      userMessage,
      assistantMessage,
      question,
      priorExchanges,
      signal,
    );
  }

  /**
   * Runs the agent loop instead of RAG retrieval: no condensation, no
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
    const { userMessage, assistantMessage } =
      await this.messagesRepository.createTurn(conversationId, question);

    yield {
      type: 'message_created',
      data: {
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
      },
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
      let servedBy: string | undefined;
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
            await this.messagesRepository.updateContent(
              assistantMessage.id,
              buffer,
            );
            lastFlushAt = Date.now();
          }
        } else if (event.type === 'tool_call') {
          yield { type: 'tool', data: { name: event.name, args: event.args } };
        } else if (event.type === 'done') {
          usage = event.usage;
          trace = event.trace;
          stopReason = event.stopReason;
          evidence = event.evidence;
          servedBy = event.servedBy;
        }
      }

      if (signal.aborted) {
        await this.messagesRepository.updateContent(
          assistantMessage.id,
          buffer,
        );
        return;
      }

      if (stopReason === 'budget_exhausted') {
        // Graceful degradation (docs/phases/phase-7-agentic-search.md §2): the
        // exhausted trajectory's own partial text is discarded in favor of a
        // complete RAG answer on the same row — but its `tool_trace` is worth
        // keeping, so `generateRagAnswer` is told about it explicitly.
        const priorExchanges = await this.computePriorExchanges(
          conversationId,
          conversation.summarizedThroughMsgId,
        );
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
      const { provider, model } = this.splitProviderId(
        servedBy ?? this.chatProvider.id,
      );

      await this.messagesRepository.completeAssistant(assistantMessage.id, {
        content: buffer,
        provider,
        model,
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

      yield {
        type: 'done',
        data: { messageId: assistantMessage.id, citations, usage, latencyMs },
      };

      try {
        if (!conversation.title) {
          await this.conversationsRepository.setTitle(
            conversationId,
            question.slice(0, TITLE_MAX_LENGTH),
          );
        }
        await this.conversationsRepository.touch(conversationId);
      } catch {
        // ignore — title/updatedAt bookkeeping is cosmetic, not correctness-critical
      }
    } catch (err) {
      if (signal.aborted) {
        await this.messagesRepository.updateContent(
          assistantMessage.id,
          buffer,
        );
        return;
      }
      const message = this.clientFacingError(err);
      await this.messagesRepository.markError(
        assistantMessage.id,
        buffer,
        message,
      );
      yield {
        type: 'error',
        data: { messageId: assistantMessage.id, message },
      };
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
      // Only a conversation created via `createMultiProjectConversation` has
      // rows here — an ordinary single-project conversation gets none, and
      // retrieval below takes the exact original single-project call in that
      // case, including its original "throw loudly on an embedding-model
      // mismatch" behavior (correct when there's no other project to fall
      // back to). `project` stays null for multi-project — see the
      // `overview` note below.
      const memberProjectIds =
        await this.conversationProjectsRepository.findProjectIds(
          conversation.id,
        );
      const isMultiProject = memberProjectIds.length >= 2;
      const project = isMultiProject
        ? null
        : await this.projectsRepository.findById(conversation.projectId);

      let retrievalQuery = question;
      if (priorExchanges.length > 0) {
        yield { type: 'status', data: { stage: 'condensing' } };
        const condensationWindow = recentWindow(
          priorExchanges,
          CONDENSATION_WINDOW,
        ).map(toPromptExchange);
        const { system, user } = buildCondensationPrompt(
          condensationWindow,
          question,
        );
        const condensed = await this.chatProvider.complete(
          { system, user, maxTokens: CONDENSE_MAX_TOKENS },
          signal,
        );
        if (signal.aborted) return;
        if (condensed.text.trim()) retrievalQuery = condensed.text.trim();
      }
      await this.messagesRepository.setRetrievalQuery(
        assistantMessage.id,
        retrievalQuery,
      );

      yield { type: 'status', data: { stage: 'retrieving' } };
      const scoredChunks: ScoredChunkWithProject[] = isMultiProject
        ? await this.retrieveAcrossProjects(
            memberProjectIds,
            retrievalQuery,
            TOP_K,
          )
        : (
            await this.retrievalService.search(
              conversation.projectId,
              retrievalQuery,
              'hybrid',
              TOP_K,
            )
          ).map((chunk) => ({ ...chunk, projectId: conversation.projectId }));
      if (signal.aborted) return;

      const evidence: EvidenceBlock[] = scoredChunks.map((chunk) => ({
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        projectId: isMultiProject ? chunk.projectId : undefined,
      }));

      // Emitted before the first token so `[1]` becomes a live chip the
      // instant it streams in, and so a slow first token has something to
      // show. Markers are 1-based positions in `scoredChunks`, matching how
      // `parseCitations` resolves `[n]` against the same-ordered `evidence`.
      // `projectId` is only ever attached for a multi-project conversation —
      // see `SourceRef`'s doc comment.
      yield {
        type: 'sources',
        data: {
          sources: scoredChunks.map((chunk, i) => ({
            marker: i + 1,
            path: chunk.path,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            score: chunk.score,
            projectId: isMultiProject ? chunk.projectId : undefined,
          })),
        },
      };

      // The model is shown the ORIGINAL question here, never the condensed
      // one — condensation is for retrieval only, and reads robotic otherwise.
      // No `overview` for a multi-project conversation — which project's
      // overview would even apply is an open design question (see
      // docs/PROGRESS.md), deliberately deferred rather than guessed at.
      const generationWindow = recentWindow(
        priorExchanges,
        GENERATION_WINDOW,
      ).map(toPromptExchange);
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
      let servedBy: string | undefined;

      for await (const event of this.chatProvider.stream(
        { system: SYSTEM_PROMPT, user, maxTokens: GENERATION_MAX_TOKENS },
        signal,
      )) {
        if (event.type === 'text') {
          buffer += event.delta;
          yield { type: 'token', data: { delta: event.delta } };
          if (Date.now() - lastFlushAt >= FLUSH_INTERVAL_MS) {
            await this.messagesRepository.updateContent(
              assistantMessage.id,
              buffer,
            );
            lastFlushAt = Date.now();
          }
        } else if (event.type === 'usage') {
          usage = {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
          };
        } else if (event.type === 'done') {
          servedBy = event.servedBy;
        }
      }

      if (signal.aborted) {
        await this.messagesRepository.updateContent(
          assistantMessage.id,
          buffer,
        );
        return;
      }

      const citations = parseCitations(buffer, evidence);
      const latencyMs = Date.now() - startedAt;
      const { provider, model } = this.splitProviderId(
        servedBy ?? this.chatProvider.id,
      );

      await this.messagesRepository.completeAssistant(assistantMessage.id, {
        content: buffer,
        provider,
        model,
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
          // Denormalized only for a multi-project conversation — see
          // `citations.projectId`'s doc comment in schema.ts.
          projectId: isMultiProject ? chunk.projectId : null,
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

      yield {
        type: 'done',
        data: { messageId: assistantMessage.id, citations, usage, latencyMs },
      };

      // Best-effort bookkeeping — the turn above is already durably complete,
      // so a hiccup here must never flip status back to 'error'.
      try {
        if (!conversation.title) {
          await this.conversationsRepository.setTitle(
            conversation.id,
            question.slice(0, TITLE_MAX_LENGTH),
          );
        }
        await this.conversationsRepository.touch(conversation.id);
      } catch {
        // ignore — title/updatedAt bookkeeping is cosmetic, not correctness-critical
      }
      // The summary is NOT cosmetic — it's the rolling context a long
      // conversation relies on once turns fall out of the recent window. A
      // silent failure here degrades later answers with no trace (exactly the
      // kind of thing `diagnose-answer` can't find), so log it. Still
      // best-effort: the completed turn above must never flip back to 'error'.
      try {
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
      } catch (err) {
        this.logger.warn(
          `Conversation summary update failed for ${conversation.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } catch (err) {
      if (signal.aborted) {
        await this.messagesRepository.updateContent(
          assistantMessage.id,
          buffer,
        );
        return;
      }
      const message = this.clientFacingError(err);
      await this.messagesRepository.markError(
        assistantMessage.id,
        buffer,
        message,
      );
      yield {
        type: 'error',
        data: { messageId: assistantMessage.id, message },
      };
    }
  }

  /**
   * Searches every member project independently and merges the results with
   * `reciprocalRankFusion` — unchanged from single-project retrieval, since
   * RRF fuses by rank position on bare (globally-unique) chunk ids with zero
   * knowledge of which project an id came from. A project that fails (an
   * embedding-model mismatch, mid-reindex, deleted) is skipped and logged
   * rather than failing the whole turn — the one behavior that's genuinely
   * new here, and deliberately NOT applied to the single-project path, which
   * should keep failing loudly when its one and only project has a problem.
   */
  private async retrieveAcrossProjects(
    projectIds: string[],
    query: string,
    limit: number,
  ): Promise<ScoredChunkWithProject[]> {
    // Embed the query ONCE for the whole fan-out; each per-project
    // hybrid search reuses this vector instead of re-embedding M times.
    const queryVector = await this.retrievalService.embedQuery(query);

    const perProject = await Promise.all(
      projectIds.map(async (projectId) => {
        try {
          return {
            projectId,
            chunks: await this.retrievalService.searchWithQueryVector(
              projectId,
              query,
              queryVector,
              limit,
            ),
          };
        } catch (err) {
          this.logger.warn(
            `Multi-project retrieval skipped project ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return { projectId, chunks: [] as ScoredChunk[] };
        }
      }),
    );

    const byId = new Map<string, ScoredChunkWithProject>();
    const lists: RankedList[] = [];
    for (const { projectId, chunks } of perProject) {
      if (chunks.length === 0) continue;
      lists.push({ ids: chunks.map((c) => c.chunkId) });
      for (const chunk of chunks)
        byId.set(chunk.chunkId, { ...chunk, projectId });
    }

    return reciprocalRankFusion(lists)
      .slice(0, limit)
      .map((fused) => byId.get(fused.id)!);
  }

  /**
   * The pair just inserted for this turn is always the newest two rows —
   * everything before them is prior turns to condense/summarize against.
   * Only a successfully completed turn is trustworthy context.
   */
  private async computePriorExchanges(
    conversationId: string,
    summarizedThroughMsgId: string | null,
  ): Promise<Exchange[]> {
    // Bound the per-turn fetch: once a summary watermark exists, everything
    // before it is already folded into `conversations.summary`, so load only the
    // un-summarized tail — which still covers the recent windows and the eviction
    // set below (eviction always leaves GENERATION_WINDOW complete exchanges
    // after the watermark) — instead of the full, ever-growing transcript.
    // Before the first summary the whole (still short) history is loaded, as before.
    const allMessages = summarizedThroughMsgId
      ? await this.messagesRepository.findAfterMessage(
          conversationId,
          summarizedThroughMsgId,
        )
      : await this.messagesRepository.findAllByConversation(conversationId);
    return toExchanges(allMessages.slice(0, -2)).filter(
      (ex) => ex.answerStatus === 'complete',
    );
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
    // The raw-count trigger only applies before the first summary. Once a
    // watermark exists, `priorExchanges` is just the un-summarized tail (not the
    // full history — see computePriorExchanges), so this count would wrongly stop
    // summarizing; skip the gate then and let eviction fold the tail forward.
    if (
      !conversation.summarizedThroughMsgId &&
      allExchanges.length <= SUMMARY_TRIGGER_EXCHANGES
    )
      return;

    const evicted = evictedExchanges(
      allExchanges,
      GENERATION_WINDOW,
      conversation.summarizedThroughMsgId,
    );
    if (evicted.length === 0) return;

    const { system, user } = buildSummaryPrompt(
      conversation.summary,
      evicted.map(toPromptExchange),
    );
    const summarized = await this.chatProvider.complete(
      { system, user, maxTokens: SUMMARY_MAX_TOKENS },
      signal,
    );
    const newSummary = summarized.text.trim();
    if (!newSummary) return;

    const lastEvicted = evicted[evicted.length - 1]!;
    await this.conversationsRepository.updateSummary(
      conversation.id,
      newSummary,
      lastEvicted.assistantMessageId,
    );
  }

  /**
   * Splits a provider id ("gemini:gemini-flash-latest", or
   * "groq:openai/gpt-oss-120b" whose model itself contains a colon) into the
   * persisted provider/model pair. Fed the id of the provider that ACTUALLY
   * served the turn (see `ChatCompletion.servedBy`), so a failed-over turn is
   * recorded under Groq, not the configured-primary Gemini.
   */
  private splitProviderId(id: string): {
    provider: string;
    model: string | null;
  } {
    const [provider, ...modelParts] = id.split(':');
    return {
      provider: provider ?? id,
      model: modelParts.length > 0 ? modelParts.join(':') : null,
    };
  }

  private async requireConversation(id: string): Promise<ConversationRow> {
    const conversation = await this.conversationsRepository.findById(id);
    if (!conversation)
      throw new NotFoundException(`Conversation ${id} not found`);
    return conversation;
  }

  /**
   * DEF-028. What the user is allowed to read when a turn fails.
   *
   * A raw provider message used to be streamed straight into the transcript.
   * What that actually put on screen, verbatim, was a vendor's internal
   * organisation id, its model id, a JSON blob, and a billing upsell link —
   * none of which belongs in this product's UI, and none of which a user can
   * act on. The raw text is logged server-side instead, where it is useful.
   *
   * Only RECOGNISED provider conditions are translated. Anything else keeps the
   * previous behaviour (redacted raw message), because flattening every failure
   * into "the model is busy" would hide real defects behind a reassuring
   * sentence — the mistake this is careful not to make.
   *
   * `redactSecrets` still runs on that fallback: a provider or git error can
   * echo a credential in its own message text, the same hazard
   * WorkerService.recordFailure guards against.
   */
  private clientFacingError(err: unknown): string {
    const raw = err instanceof Error ? err.message : 'Unknown error';
    const friendly = userFacingProviderMessage(err);
    if (friendly) {
      this.logger.warn(
        `Provider failure surfaced to the user: ${redactSecrets(raw)}`,
      );
      return friendly;
    }
    return redactSecrets(raw);
  }
}

function toPromptExchange(exchange: Exchange): {
  question: string;
  answer: string;
} {
  return {
    question: exchange.question,
    answer: truncateAnswer(exchange.answer),
  };
}
