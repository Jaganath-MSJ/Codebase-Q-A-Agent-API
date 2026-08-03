import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../pool';
import { DB_TOKEN } from '../tokens';
import { indexingJobs, IndexingJobRow } from '../schema';

@Injectable()
export class JobsRepository {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async enqueue(projectId: string, trigger: string): Promise<IndexingJobRow> {
    const [row] = await this.db.insert(indexingJobs).values({ projectId, trigger }).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async findLatestByProject(projectId: string): Promise<IndexingJobRow | undefined> {
    const [row] = await this.db
      .select()
      .from(indexingJobs)
      .where(eq(indexingJobs.projectId, projectId))
      .orderBy(desc(indexingJobs.createdAt))
      .limit(1);
    return row;
  }

  /** Claims the oldest queued job with FOR UPDATE SKIP LOCKED, so concurrent workers never claim the same row. */
  async claimNext(): Promise<IndexingJobRow | undefined> {
    return this.db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({ id: indexingJobs.id })
        .from(indexingJobs)
        .where(eq(indexingJobs.status, 'queued'))
        .orderBy(indexingJobs.createdAt)
        .limit(1)
        .for('update', { skipLocked: true });

      if (!candidate) return undefined;

      const [row] = await tx
        .update(indexingJobs)
        .set({ status: 'running', startedAt: new Date() })
        .where(eq(indexingJobs.id, candidate.id))
        .returning();
      return row;
    });
  }

  async updateProgress(id: string, data: { filesTotal?: number; filesDone?: number }): Promise<void> {
    await this.db.update(indexingJobs).set(data).where(eq(indexingJobs.id, id));
  }

  async markSucceeded(id: string): Promise<void> {
    await this.db
      .update(indexingJobs)
      .set({ status: 'succeeded', finishedAt: new Date() })
      .where(eq(indexingJobs.id, id));
  }

  async markFailed(id: string, errorMessage: string): Promise<void> {
    await this.db
      .update(indexingJobs)
      .set({ status: 'failed', errorMessage, finishedAt: new Date() })
      .where(eq(indexingJobs.id, id));
  }
}
