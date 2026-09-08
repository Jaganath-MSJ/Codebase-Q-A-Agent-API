import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { ConfigModule } from '../src/config/config.module';
import { DbModule } from '../src/db/db.module';
import { ProjectsRepository } from '../src/db/repositories/projects.repository';
import { RetrievalModule } from '../src/retrieval/retrieval.module';
import { VectorRetriever } from '../src/retrieval/vector.retriever';
import { EMBEDDING_PROVIDER_TOKEN } from '../src/embeddings/embeddings.module';
import type { EmbeddingProvider } from '../src/embeddings/embedding-provider.interface';

// Recall-stability gate for approximate-index changes (12.1 HNSW, 12.8 batching).
// The canonical `npm run eval` needs a "Tiny Repo" fixture that isn't present in
// every environment; this instead proves an index change didn't move results by
// comparing each query's vector top-10 against a baseline captured with the old
// index (or none). Run it once to snapshot a baseline, then again after the
// change with the baseline path to get recall@5/@10 and top-1 agreement.
//
//   ts-node evals/topk-stability.ts "<Project>" <out.json>                 # snapshot
//   ts-node evals/topk-stability.ts "<Project>" <after.json> <before.json> # compare

const TOP_K = 10;

interface EvalQuestion {
  q: string;
  expectedFiles: string[];
}
type Snapshot = Record<number, string[]>; // question index -> top-K chunkIds

@Module({ imports: [ConfigModule, DbModule, RetrievalModule] })
class TopKModule {}

function recallAt(baseline: string[], candidate: string[], k: number): number {
  const base = baseline.slice(0, k);
  if (base.length === 0) return 1;
  const cand = new Set(candidate.slice(0, k));
  return base.filter((id) => cand.has(id)).length / base.length;
}

async function main(): Promise<void> {
  const projectName = process.argv[2];
  const outFile = process.argv[3];
  const baselineFile = process.argv[4];
  if (!projectName || !outFile) {
    throw new Error('usage: topk-stability.ts "<Project>" <out.json> [baseline.json]');
  }

  const questions: EvalQuestion[] = JSON.parse(
    readFileSync(path.join(__dirname, 'questions.json'), 'utf8'),
  );

  const app = await NestFactory.createApplicationContext(TopKModule, {
    logger: false,
    abortOnError: false,
  });

  try {
    const projectsRepository = app.get(ProjectsRepository);
    const vectorRetriever = app.get(VectorRetriever);
    const embeddingProvider = app.get<EmbeddingProvider>(EMBEDDING_PROVIDER_TOKEN);

    const project = (await projectsRepository.findAll()).find((p) => p.name === projectName);
    if (!project) throw new Error(`No project named '${projectName}' found.`);
    if (project.embeddingModel !== embeddingProvider.id) {
      throw new Error(
        `Project '${project.name}' indexed with '${project.embeddingModel}' != active '${embeddingProvider.id}'.`,
      );
    }

    const snapshot: Snapshot = {};
    for (let i = 0; i < questions.length; i++) {
      const qv = await embeddingProvider.embedQuery(questions[i]!.q);
      const hits = await vectorRetriever.search(project.id, qv, TOP_K);
      snapshot[i] = hits.map((h) => h.chunkId);
    }
    writeFileSync(outFile, JSON.stringify(snapshot, null, 2));
    console.log(`\ntopk-stability · '${project.name}' · ${questions.length} questions · wrote ${outFile}`);

    if (baselineFile && existsSync(baselineFile)) {
      const baseline: Snapshot = JSON.parse(readFileSync(baselineFile, 'utf8'));
      const r5: number[] = [];
      const r10: number[] = [];
      let top1 = 0;
      for (let i = 0; i < questions.length; i++) {
        const base = baseline[i] ?? [];
        const cand = snapshot[i] ?? [];
        r5.push(recallAt(base, cand, 5));
        r10.push(recallAt(base, cand, 10));
        if (base[0] && base[0] === cand[0]) top1++;
      }
      const avg = (xs: number[]): number => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN);
      console.log(`\n-- recall of baseline top-k preserved by new index --`);
      console.log(`recall@5  : ${avg(r5).toFixed(3)}`);
      console.log(`recall@10 : ${avg(r10).toFixed(3)}`);
      console.log(`top-1 agree: ${top1}/${questions.length}`);
      const perfect = avg(r5) === 1 && avg(r10) === 1;
      console.log(perfect ? 'RESULT: no regression (identical top-k sets)\n' : 'RESULT: results moved — inspect above\n');
    }
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
