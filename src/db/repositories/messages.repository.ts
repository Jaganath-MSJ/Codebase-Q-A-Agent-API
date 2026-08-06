import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../pool';
import { DB_TOKEN } from '../tokens';
import { messages, MessageRow } from '../schema';

@Injectable()
export class MessagesRepository {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /** Inserts a user message and its assistant reply atomically — never one without the other. */
  async createTurn(
    conversationId: string,
    userContent: string,
    assistantContent: string,
  ): Promise<{ userMessage: MessageRow; assistantMessage: MessageRow }> {
    return this.db.transaction(async (tx) => {
      const [userMessage] = await tx
        .insert(messages)
        .values({ conversationId, role: 'user', content: userContent })
        .returning();
      const [assistantMessage] = await tx
        .insert(messages)
        .values({ conversationId, role: 'assistant', content: assistantContent })
        .returning();
      if (!userMessage || !assistantMessage) throw new Error('Insert returned no row');
      return { userMessage, assistantMessage };
    });
  }

  async findAllByConversation(conversationId: string): Promise<MessageRow[]> {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt));
  }
}
