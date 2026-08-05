import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../pool';
import { DB_TOKEN } from '../tokens';
import { indexingJobs, IndexingJobRow, NewIndexingJobRow } from '../schema';

export type ProgressUpdate = Partial<
  Pick<
    NewIndexingJobRow,
    'phase' | 'currentPath' | 'filesTotal' | 'filesDone' | 'chunksTotal' | 'chunksEmbedded'
  >
>;

const LEASE_MS = 2 * 60_000;

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

  /**
   * Fails any reclaimable job (a crashed worker's lease expired) that has
   * already used up its retry budget, before it can be reclaimed yet again.
   * A plain guarded UPDATE — safe to run from any number of workers.
   */
  async failExceededAttempts(): Promise<void> {
    await this.db
      .update(indexingJobs)
      .set({
        status: 'failed',
        errorMessage: 'Exceeded max_attempts after repeated crashes',
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(indexingJobs.status, 'running'),
          lt(indexingJobs.leaseExpiresAt, new Date()),
          gte(indexingJobs.attempt, indexingJobs.maxAttempts),
        ),
      );
  }

  /**
   * Claims the oldest queued job, or reclaims a crashed worker's job whose
   * lease expired (bumping `attempt`). FOR UPDATE SKIP LOCKED so concurrent
   * workers never claim the same row.
   */
  async claimNext(): Promise<IndexingJobRow | undefined> {
    return this.db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({ id: indexingJobs.id, status: indexingJobs.status, attempt: indexingJobs.attempt })
        .from(indexingJobs)
        .where(
          or(
            eq(indexingJobs.status, 'queued'),
            and(eq(indexingJobs.status, 'running'), lt(indexingJobs.leaseExpiresAt, new Date())),
          ),
        )
        .orderBy(indexingJobs.createdAt)
        .limit(1)
        .for('update', { skipLocked: true });

      if (!candidate) return undefined;

      const isReclaim = candidate.status === 'running';
      const [row] = await tx
        .update(indexingJobs)
        .set({
          status: 'running',
          startedAt: sql`coalesce(${indexingJobs.startedAt}, now())`,
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
          attempt: isReclaim ? candidate.attempt + 1 : candidate.attempt,
        })
        .where(eq(indexingJobs.id, candidate.id))
        .returning();
      return row;
    });
  }

  /** Extends the lease while a worker is still actively processing a job. */
  async heartbeat(id: string): Promise<void> {
    await this.db
      .update(indexingJobs)
      .set({ leaseExpiresAt: new Date(Date.now() + LEASE_MS) })
      .where(eq(indexingJobs.id, id));
  }

  async updateProgress(id: string, data: ProgressUpdate): Promise<void> {
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
