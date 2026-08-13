import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { ConfigModule } from '../src/config/config.module';
import { DbModule } from '../src/db/db.module';
import { ProjectsRepository } from '../src/db/repositories/projects.repository';
import { RetrievalModule } from '../src/retrieval/retrieval.module';
import { RetrievalService, RetrievalMode } from '../src/retrieval/retrieval.service';
import { average, recallAt, reciprocalRank } from './metrics';

const PROJECT_NAME = 'Tiny Repo';
const TOP_K = 10;
const MODES: RetrievalMode[] = ['vector', 'fts', 'trigram', 'hybrid'];

interface EvalQuestion {
  q: string;
  expectedFiles: string[];
}

@Module({ imports: [ConfigModule, DbModule, RetrievalModule] })
class EvalModule {}

async function main(): Promise<void> {
  const questions: EvalQuestion[] = JSON.parse(
    readFileSync(path.join(__dirname, 'questions.json'), 'utf8'),
  );

  const app = await NestFactory.createApplicationContext(EvalModule, { logger: false });

  try {
    const projectsRepository = app.get(ProjectsRepository);
    const retrievalService = app.get(RetrievalService);

    const project = (await projectsRepository.findAll()).find((p) => p.name === PROJECT_NAME);
    if (!project) {
      throw new Error(
        `No project named '${PROJECT_NAME}' found. Add fixtures/tiny-repo as a local_path project and index it first.`,
      );
    }

    console.log(`Evaluating ${questions.length} questions against '${project.name}'\n`);

    const rows: { mode: RetrievalMode; recall5: number; recall10: number; mrr: number }[] = [];

    for (const mode of MODES) {
      const recall5: number[] = [];
      const recall10: number[] = [];
      const mrr: number[] = [];

      console.log(`-- ${mode} --`);

      for (const question of questions) {
        const results = await retrievalService.search(project.id, question.q, mode, TOP_K);

        const r5 = recallAt(results, question.expectedFiles, 5);
        const r10 = recallAt(results, question.expectedFiles, 10);
        const rr = reciprocalRank(results, question.expectedFiles);

        recall5.push(r5);
        recall10.push(r10);
        mrr.push(rr);

        const mark = rr > 0 ? `hit @${Math.round(1 / rr)}` : 'miss';
        console.log(`  [${mark.padEnd(8)}] ${question.q}`);
      }

      rows.push({
        mode,
        recall5: average(recall5),
        recall10: average(recall10),
        mrr: average(mrr),
      });
      console.log('');
    }

    console.log('| Mode    | recall@5 | recall@10 | MRR  |');
    console.log('|---------|----------|-----------|------|');
    for (const row of rows) {
      console.log(
        `| ${row.mode.padEnd(7)} | ${row.recall5.toFixed(2).padStart(8)} | ${row.recall10.toFixed(2).padStart(9)} | ${row.mrr.toFixed(2).padStart(4)} |`,
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
