import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../pool';
import { DB_TOKEN } from '../tokens';
import { conversations, ConversationRow, NewConversationRow } from '../schema';

@Injectable()
export class ConversationsRepository {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async create(
    data: Pick<NewConversationRow, 'projectId' | 'title'>,
  ): Promise<ConversationRow> {
    const [row] = await this.db.insert(conversations).values(data).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async findAllByProject(projectId: string): Promise<ConversationRow[]> {
    return this.db
      .select()
      .from(conversations)
      .where(eq(conversations.projectId, projectId))
      .orderBy(desc(conversations.updatedAt));
  }

  async findById(id: string): Promise<ConversationRow | undefined> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id));
    return row;
  }

  async touch(id: string): Promise<void> {
    await this.db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, id));
  }

  async setTitle(id: string, title: string): Promise<void> {
    await this.db
      .update(conversations)
      .set({ title })
      .where(eq(conversations.id, id));
  }

  /** Folds newly-evicted exchanges into the rolling summary and advances the high-water mark. */
  async updateSummary(
    id: string,
    summary: string,
    summarizedThroughMsgId: string,
  ): Promise<void> {
    await this.db
      .update(conversations)
      .set({ summary, summarizedThroughMsgId })
      .where(eq(conversations.id, id));
  }
}
