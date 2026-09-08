import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { sql, eq, and, isNotNull, cosineDistance } from 'drizzle-orm';
import { ConfigModule } from '../src/config/config.module';
import { DbModule } from '../src/db/db.module';
import { ProjectsRepository } from '../src/db/repositories/projects.repository';
import { RetrievalModule } from '../src/retrieval/retrieval.module';
import { RetrievalService } from '../src/retrieval/retrieval.service';
import { VectorRetriever } from '../src/retrieval/vector.retriever';
import { EMBEDDING_PROVIDER_TOKEN } from '../src/embeddings/embeddings.module';
import type { EmbeddingProvider } from '../src/embeddings/embedding-provider.interface';
import { DB_TOKEN } from '../src/db/tokens';
import type { Db } from '../src/db/pool';
import { chunks, files } from '../src/db/schema';

// Read-only retrieval benchmark. Captures the pre-12.1 latency baseline so the
// HNSW index's effect (vector p50/p95 dropping, and no longer growing with the
// total corpus) is measurable. Reuses run-eval.ts's Nest bootstrap and the same
// `questions.json`. No schema or prod changes — it only reads.
//
// Run against Tiny Repo (default) AND one large smoke-test repo before 12.1:
//   npm run bench                 # Tiny Repo
//   npm run bench -- "Big Repo"   # or: BENCH_PROJECT="Big Repo" npm run bench

const DEFAULT_PROJECT = 'Tiny Repo';
const TOP_K = 10;
const N = Number(process.env.BENCH_N ?? 20);
const WARMUP = 3;

interface EvalQuestion {
  q: string;
  expectedFiles: string[];
}

@Module({ imports: [ConfigModule, DbModule, RetrievalModule] })
class BenchModule {}

/** Nearest-rank percentile over an already-sorted ascending array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

interface Summary {
  label: string;
  n: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  mean: number;
}

function summarize(label: string, samples: number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    label,
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0] ?? NaN,
    max: sorted[sorted.length - 1] ?? NaN,
    mean: sorted.length > 0 ? sum / sorted.length : NaN,
  };
}

function printSummaryTable(summaries: Summary[]): void {
  console.log('| Metric                    |   n | p50 (ms) | p95 (ms) | min (ms) | max (ms) | mean (ms) |');
  console.log('|---------------------------|-----|----------|----------|----------|----------|-----------|');
  for (const s of summaries) {
    console.log(
      `| ${s.label.padEnd(25)} | ${String(s.n).padStart(3)} | ` +
        `${s.p50.toFixed(2).padStart(8)} | ${s.p95.toFixed(2).padStart(8)} | ` +
        `${s.min.toFixed(2).padStart(8)} | ${s.max.toFixed(2).padStart(8)} | ` +
        `${s.mean.toFixed(2).padStart(9)} |`,
    );
  }
}

/**
 * EXPLAIN (ANALYZE, BUFFERS) for the vector query, replicating vector.retriever.ts
 * exactly (same transaction, `SET LOCAL hnsw.ef_search`, cosine `<=>`, the
 * `embedding IS NOT NULL` predicate, and the `distance, id` ordering) so the plan
 * reflects the real retrieval path. Returns the plan lines as printed by Postgres.
 */
async function explainVectorQuery(
  db: Db,
  projectId: string,
  queryVector: number[],
  limit: number,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL hnsw.ef_search = 100`);

    const distance = cosineDistance(chunks.embedding, queryVector);
    const query = tx
      .select({
        chunkId: chunks.id,
        path: files.path,
        startLine: chunks.startLine,
        endLine: chunks.endLine,
        content: chunks.content,
        contentHash: chunks.contentHash,
        symbol: chunks.symbol,
        score: sql<number>`1 - (${distance})`,
      })
      .from(chunks)
      .innerJoin(files, eq(files.id, chunks.fileId))
      .where(and(eq(chunks.projectId, projectId), isNotNull(chunks.embedding)))
      .orderBy(distance, chunks.id)
      .limit(limit);

    const res = await tx.execute(sql`EXPLAIN (ANALYZE, BUFFERS) ${query.getSQL()}`);
    return res.rows.map((r) => String(r['QUERY PLAN']));
  });
}

async function main(): Promise<void> {
  const projectName = process.argv[2] ?? process.env.BENCH_PROJECT ?? DEFAULT_PROJECT;

  const questions: EvalQuestion[] = JSON.parse(
    readFileSync(path.join(__dirname, 'questions.json'), 'utf8'),
  );

  const app = await NestFactory.createApplicationContext(BenchModule, { logger: false });

  try {
    const projectsRepository = app.get(ProjectsRepository);
    const retrievalService = app.get(RetrievalService);
    const vectorRetriever = app.get(VectorRetriever);
    const embeddingProvider = app.get<EmbeddingProvider>(EMBEDDING_PROVIDER_TOKEN);
    const db = app.get<Db>(DB_TOKEN);

    const allProjects = await projectsRepository.findAll();
    const project = allProjects.find((p) => p.name === projectName);
    if (!project) {
      const available = allProjects.map((p) => `'${p.name}' (${p.status})`).join(', ') || '(none)';
      throw new Error(
        `No project named '${projectName}' found. Available: ${available}. ` +
          `Pass one with: npm run bench -- "<Project Name>".`,
      );
    }
    if (project.status !== 'ready') {
      throw new Error(`Project '${project.name}' is not ready (status: ${project.status}). Index it first.`);
    }
    // The DB-only path calls the retriever directly, bypassing RetrievalService's
    // model-match guard — replicate that check here so a stale-model project fails
    // loudly instead of producing meaningless numbers.
    if (project.embeddingModel !== embeddingProvider.id) {
      throw new Error(
        `Project '${project.name}' was indexed with '${project.embeddingModel}', but the active ` +
          `provider is '${embeddingProvider.id}'. Re-index before benchmarking.`,
      );
    }

    console.log(
      `\nbench-retrieval · project '${project.name}' · ${questions.length} questions · ` +
        `N=${N}/query · top_k=${TOP_K} · model ${embeddingProvider.id}\n`,
    );

    // Warm up the ONNX model, the pg pool, and query plans before timing.
    const warm = questions[0]!.q;
    for (let i = 0; i < WARMUP; i++) {
      await retrievalService.search(project.id, warm, 'vector', TOP_K);
      await retrievalService.search(project.id, warm, 'hybrid', TOP_K);
    }

    const roundTrip: Record<'vector' | 'hybrid', number[]> = { vector: [], hybrid: [] };
    const vectorDbOnly: number[] = [];

    for (const question of questions) {
      // Full round-trip (includes the per-call query embedding) for both modes.
      for (const mode of ['vector', 'hybrid'] as const) {
        for (let i = 0; i < N; i++) {
          const t0 = performance.now();
          await retrievalService.search(project.id, question.q, mode, TOP_K);
          roundTrip[mode].push(performance.now() - t0);
        }
      }

      // DB-only vector: embed once, then time just the retriever. This isolates
      // the query cost that 12.1's HNSW index changes, free of embedding noise.
      const queryVector = await embeddingProvider.embedQuery(question.q);
      for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        await vectorRetriever.search(project.id, queryVector, TOP_K);
        vectorDbOnly.push(performance.now() - t0);
      }
    }

    printSummaryTable([
      summarize('vector (round-trip)', roundTrip.vector),
      summarize('hybrid (round-trip)', roundTrip.hybrid),
      summarize('vector (db-only)', vectorDbOnly),
    ]);

    console.log('\n-- EXPLAIN (ANALYZE, BUFFERS) · vector query · first question --');
    console.log(`   q: ${questions[0]!.q}`);
    const plan = await explainVectorQuery(
      db,
      project.id,
      await embeddingProvider.embedQuery(questions[0]!.q),
      TOP_K,
    );
    for (const line of plan) console.log(`   ${line}`);
    console.log('');
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
