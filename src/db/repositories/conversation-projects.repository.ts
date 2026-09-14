import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../pool';
import { DB_TOKEN } from '../tokens';
import { conversationProjects } from '../schema';

@Injectable()
export class ConversationProjectsRepository {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async addAll(conversationId: string, projectIds: string[]): Promise<void> {
    if (projectIds.length === 0) return;
    await this.db
      .insert(conversationProjects)
      .values(projectIds.map((projectId) => ({ conversationId, projectId })));
  }

  /** Empty for an ordinary single-project conversation — only a genuinely multi-project one has rows here. */
  async findProjectIds(conversationId: string): Promise<string[]> {
    const rows = await this.db
      .select({ projectId: conversationProjects.projectId })
      .from(conversationProjects)
      .where(eq(conversationProjects.conversationId, conversationId));
    return rows.map((r) => r.projectId);
  }

  /** Batched form of `findProjectIds` for a whole conversation list — one query, not N. A conversation absent from the returned map has no rows (ordinary single-project). */
  async findProjectIdsForConversations(
    conversationIds: string[],
  ): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (conversationIds.length === 0) return map;

    const rows = await this.db
      .select({
        conversationId: conversationProjects.conversationId,
        projectId: conversationProjects.projectId,
      })
      .from(conversationProjects)
      .where(inArray(conversationProjects.conversationId, conversationIds));

    for (const row of rows) {
      const list = map.get(row.conversationId);
      if (list) list.push(row.projectId);
      else map.set(row.conversationId, [row.projectId]);
    }
    return map;
  }
}
