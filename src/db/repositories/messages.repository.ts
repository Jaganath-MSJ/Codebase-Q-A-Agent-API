import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { Db } from '../pool';
import { DB_TOKEN } from '../tokens';
import { messages, MessageRow } from '../schema';

export interface CompleteAssistantData {
  content: string;
  provider: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  /** Phase 7: the agent loop's trajectory. Undefined/omitted for RAG answers, which leaves the column null. */
  toolTrace?: unknown[] | null;
}

@Injectable()
export class MessagesRepository {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /**
   * Inserts the user's question and a placeholder assistant row atomically —
   * never one without the other. The assistant row starts as 'pending' so it
   * exists (and is visible on a reload) before generation has even started.
   *
   * The assistant's `createdAt` is set explicitly, one millisecond after the
   * user row's actual timestamp: Postgres's `now()` is frozen for the whole
   * transaction, so both inserts would otherwise get the *identical*
   * timestamp, and `findAllByConversation`'s `ORDER BY created_at` (with no
   * secondary key) would then sort them in unspecified order — silently
   * breaking `toExchanges`'s assumption that every pair is user-then-assistant.
   */
  async createTurn(
    conversationId: string,
    userContent: string,
  ): Promise<{ userMessage: MessageRow; assistantMessage: MessageRow }> {
    return this.db.transaction(async (tx) => {
      const [userMessage] = await tx
        .insert(messages)
        .values({
          conversationId,
          role: 'user',
          content: userContent,
          status: 'complete',
        })
        .returning();
      if (!userMessage) throw new Error('Insert returned no row');

      const [assistantMessage] = await tx
        .insert(messages)
        .values({
          conversationId,
          role: 'assistant',
          content: '',
          status: 'pending',
          createdAt: new Date(userMessage.createdAt.getTime() + 1),
        })
        .returning();
      if (!assistantMessage) throw new Error('Insert returned no row');

      return { userMessage, assistantMessage };
    });
  }

  async markStreaming(id: string): Promise<void> {
    await this.db
      .update(messages)
      .set({ status: 'streaming' })
      .where(eq(messages.id, id));
  }

  /** The condensed standalone query actually searched — set on every turn, even an uncondensed first one. */
  async setRetrievalQuery(id: string, retrievalQuery: string): Promise<void> {
    await this.db
      .update(messages)
      .set({ retrievalQuery })
      .where(eq(messages.id, id));
  }

  /** Periodic flush of the in-progress answer, so a dropped connection leaves a partial row, not nothing. */
  async updateContent(id: string, content: string): Promise<void> {
    await this.db.update(messages).set({ content }).where(eq(messages.id, id));
  }

  async completeAssistant(
    id: string,
    data: CompleteAssistantData,
  ): Promise<void> {
    await this.db
      .update(messages)
      .set({ ...data, status: 'complete' })
      .where(eq(messages.id, id));
  }

  async markError(id: string, content: string, error: string): Promise<void> {
    await this.db
      .update(messages)
      .set({ content, status: 'error', error })
      .where(eq(messages.id, id));
  }

  async findAllByConversation(conversationId: string): Promise<MessageRow[]> {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt));
  }

  /**
   * Messages after the summary watermark (an assistant message id whose turn is
   * already folded into `conversations.summary`), in conversation order, plus
   * the current turn. Lets `computePriorExchanges` load only the un-summarized
   * tail instead of the full, ever-growing transcript. Every row carries a
   * distinct `created_at` (createTurn offsets the assistant by 1ms), so a strict
   * `> watermark.created_at` cleanly starts at the next turn's user row. Falls
   * back to the whole history if the watermark row is missing (shouldn't happen —
   * it's an assistant id this service wrote).
   */
  async findAfterMessage(
    conversationId: string,
    afterMessageId: string,
  ): Promise<MessageRow[]> {
    const [watermark] = await this.db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.id, afterMessageId));
    if (!watermark) return this.findAllByConversation(conversationId);
    return this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          gt(messages.createdAt, watermark.createdAt),
        ),
      )
      .orderBy(asc(messages.createdAt), asc(messages.id));
  }
}
