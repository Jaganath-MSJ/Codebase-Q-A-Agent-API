import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
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
}

@Injectable()
export class MessagesRepository {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /**
   * Inserts the user's question and a placeholder assistant row atomically —
   * never one without the other. The assistant row starts as 'pending' so it
   * exists (and is visible on a reload) before generation has even started.
   */
  async createTurn(
    conversationId: string,
    userContent: string,
  ): Promise<{ userMessage: MessageRow; assistantMessage: MessageRow }> {
    return this.db.transaction(async (tx) => {
      const [userMessage] = await tx
        .insert(messages)
        .values({ conversationId, role: 'user', content: userContent, status: 'complete' })
        .returning();
      const [assistantMessage] = await tx
        .insert(messages)
        .values({ conversationId, role: 'assistant', content: '', status: 'pending' })
        .returning();
      if (!userMessage || !assistantMessage) throw new Error('Insert returned no row');
      return { userMessage, assistantMessage };
    });
  }

  async markStreaming(id: string): Promise<void> {
    await this.db.update(messages).set({ status: 'streaming' }).where(eq(messages.id, id));
  }

  /** Periodic flush of the in-progress answer, so a dropped connection leaves a partial row, not nothing. */
  async updateContent(id: string, content: string): Promise<void> {
    await this.db.update(messages).set({ content }).where(eq(messages.id, id));
  }

  async completeAssistant(id: string, data: CompleteAssistantData): Promise<void> {
    await this.db.update(messages).set({ ...data, status: 'complete' }).where(eq(messages.id, id));
  }

  async markError(id: string, content: string, error: string): Promise<void> {
    await this.db.update(messages).set({ content, status: 'error', error }).where(eq(messages.id, id));
  }

  async findAllByConversation(conversationId: string): Promise<MessageRow[]> {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt));
  }
}
