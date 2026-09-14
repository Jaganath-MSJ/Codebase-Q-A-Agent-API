import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lt, or, sql, sum } from 'drizzle-orm';
import type { Db } from '../pool';
import { DB_TOKEN } from '../tokens';
import { indexingJobs, IndexingJobRow, NewIndexingJobRow } from '../schema';

type ProgressUpdate = Partial<
  Pick<
    NewIndexingJobRow,
    | 'phase'
    | 'currentPath'
    | 'filesTotal'
    | 'filesDone'
    | 'filesSkipped'
    | 'skipReasons'
    | 'chunksTotal'
    | 'chunksEmbedded'
    | 'embedRequests'
  >
>;

const LEASE_MS = 2 * 60_000;

@Injectable()
export class JobsRepository {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async enqueue(projectId: string, trigger: string): Promise<IndexingJobRow> {
    const [row] = await this.db
      .insert(indexingJobs)
      .values({ projectId, trigger })
      .returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async findLatestByProject(
    projectId: string,
  ): Promise<IndexingJobRow | undefined> {
    const [row] = await this.db
      .select()
      .from(indexingJobs)
      .where(eq(indexingJobs.projectId, projectId))
      .orderBy(desc(indexingJobs.createdAt))
      .limit(1);
    return row;
  }

  /**
   * The latest job for each of `projectIds` in ONE query (Phase 12.16) — DISTINCT
   * ON keeps, per project, the row that sorts first under `project_id, created_at
   * DESC`, i.e. the most recent. Lets the projects list embed each row's latest
   * job so the dashboard doesn't fetch one per project.
   */
  async findLatestByProjectIds(
    projectIds: string[],
  ): Promise<IndexingJobRow[]> {
    if (projectIds.length === 0) return [];
    return this.db
      .selectDistinctOn([indexingJobs.projectId])
      .from(indexingJobs)
      .where(inArray(indexingJobs.projectId, projectIds))
      .orderBy(indexingJobs.projectId, desc(indexingJobs.createdAt));
  }

  async findById(id: string): Promise<IndexingJobRow | undefined> {
    const [row] = await this.db
      .select()
      .from(indexingJobs)
      .where(eq(indexingJobs.id, id));
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
   * Claims the oldest queued or paused job, or reclaims a crashed worker's
   * job whose lease expired (bumping `attempt` — but resuming from a pause
   * is not a crash, so that case leaves `attempt` alone). FOR UPDATE SKIP
   * LOCKED so concurrent workers never claim the same row.
   */
  async claimNext(): Promise<IndexingJobRow | undefined> {
    return this.db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({
          id: indexingJobs.id,
          status: indexingJobs.status,
          attempt: indexingJobs.attempt,
        })
        .from(indexingJobs)
        .where(
          or(
            eq(indexingJobs.status, 'queued'),
            eq(indexingJobs.status, 'paused'),
            and(
              eq(indexingJobs.status, 'running'),
              lt(indexingJobs.leaseExpiresAt, new Date()),
            ),
          ),
        )
        .orderBy(indexingJobs.createdAt)
        .limit(1)
        .for('update', { skipLocked: true });

      if (!candidate) return undefined;

      const isCrashReclaim = candidate.status === 'running';
      const [row] = await tx
        .update(indexingJobs)
        .set({
          status: 'running',
          startedAt: sql`coalesce(${indexingJobs.startedAt}, now())`,
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
          attempt: isCrashReclaim ? candidate.attempt + 1 : candidate.attempt,
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

  async markCanceled(id: string): Promise<void> {
    await this.db
      .update(indexingJobs)
      .set({ status: 'canceled', finishedAt: new Date() })
      .where(eq(indexingJobs.id, id));
  }

  /** Pauses rather than fails — the resume cursor means the next claim picks up exactly where this stopped. */
  async markPaused(id: string, message: string): Promise<void> {
    await this.db
      .update(indexingJobs)
      .set({ status: 'paused', errorMessage: message })
      .where(eq(indexingJobs.id, id));
  }

  async isCancelRequested(id: string): Promise<boolean> {
    const [row] = await this.db
      .select({ cancelRequested: indexingJobs.cancelRequested })
      .from(indexingJobs)
      .where(eq(indexingJobs.id, id));
    return row?.cancelRequested ?? false;
  }

  /**
   * Cancels a job. A still-queued job is canceled immediately (no worker owns
   * it yet); a running job is flagged and left for its own worker to notice
   * and exit cleanly. Returns null if there was nothing active to cancel.
   */
  async requestCancel(id: string): Promise<'canceled' | 'canceling' | null> {
    const [queuedRow] = await this.db
      .update(indexingJobs)
      .set({ status: 'canceled', finishedAt: new Date() })
      .where(
        and(
          eq(indexingJobs.id, id),
          or(
            eq(indexingJobs.status, 'queued'),
            eq(indexingJobs.status, 'paused'),
          ),
        ),
      )
      .returning({ id: indexingJobs.id });
    if (queuedRow) return 'canceled';

    const [runningRow] = await this.db
      .update(indexingJobs)
      .set({ cancelRequested: true })
      .where(and(eq(indexingJobs.id, id), eq(indexingJobs.status, 'running')))
      .returning({ id: indexingJobs.id });
    return runningRow ? 'canceling' : null;
  }

  /** The daily embedding-request budget is shared across every job, so it's a sum since midnight, not per-job. */
  async sumEmbedRequestsToday(): Promise<number> {
    const [row] = await this.db
      .select({ total: sum(indexingJobs.embedRequests) })
      .from(indexingJobs)
      .where(gte(indexingJobs.createdAt, sql`date_trunc('day', now())`));
    return Number(row?.total ?? 0);
  }
}
