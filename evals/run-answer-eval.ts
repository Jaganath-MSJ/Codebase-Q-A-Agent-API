import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { ConfigModule } from '../src/config/config.module';
import { DbModule } from '../src/db/db.module';
import { ProjectsRepository } from '../src/db/repositories/projects.repository';
import { RetrievalModule } from '../src/retrieval/retrieval.module';
import { RetrievalService } from '../src/retrieval/retrieval.service';
import { LlmModule, CHAT_PROVIDER_TOKEN } from '../src/llm/llm.module';
import type { ChatProvider } from '../src/llm/chat-provider.interface';
import { SYSTEM_PROMPT, buildUserPrompt, type EvidenceBlock } from '../src/chat/prompt.builder';
import { parseCitations } from '../src/common/citation-parser';
import { buildJudgePrompt, parseJudgeVerdict, type JudgeVerdict } from './judge';
import { average } from './metrics';

const PROJECT_NAME = 'Tiny Repo';
const TOP_K = 10;

interface AnswerEvalQuestion {
  q: string;
  expectedFiles: string[];
  expectUnanswerable: boolean;
}

@Module({ imports: [ConfigModule, DbModule, RetrievalModule, LlmModule] })
class AnswerEvalModule {}

function glyph(pass: boolean): string {
  return pass ? '✓' : '✗';
}

async function main(): Promise<void> {
  const questions: AnswerEvalQuestion[] = JSON.parse(
    readFileSync(path.join(__dirname, 'answer-questions.json'), 'utf8'),
  );

  const app = await NestFactory.createApplicationContext(AnswerEvalModule, { logger: false });

  try {
    const projectsRepository = app.get(ProjectsRepository);
    const retrievalService = app.get(RetrievalService);
    const chatProvider = app.get<ChatProvider>(CHAT_PROVIDER_TOKEN);

    const project = (await projectsRepository.findAll()).find((p) => p.name === PROJECT_NAME);
    if (!project) {
      throw new Error(
        `No project named '${PROJECT_NAME}' found. Add fixtures/tiny-repo as a local_path project and index it first.`,
      );
    }

    console.log(`Grading ${questions.length} answers from '${project.name}' with '${chatProvider.id}' as judge\n`);

    const verdicts: JudgeVerdict[] = [];
    const parseFailures: string[] = [];

    for (const question of questions) {
      const scoredChunks = await retrievalService.search(project.id, question.q, 'hybrid', TOP_K);
      const evidence: EvidenceBlock[] = scoredChunks.map((chunk) => ({
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
      }));

      const user = buildUserPrompt(evidence, question.q, {
        overview: project.overview,
        summary: null,
        recentExchanges: [],
      });
      const answer = await chatProvider.complete({ system: SYSTEM_PROMPT, user });
      const citations = parseCitations(answer.text, evidence);

      const judgePrompt = buildJudgePrompt({
        question: question.q,
        answer: answer.text,
        evidence,
        expectUnanswerable: question.expectUnanswerable,
      });
      const judgeResponse = await chatProvider.complete(judgePrompt);
      const verdict = parseJudgeVerdict(judgeResponse.text);

      if (!verdict) {
        parseFailures.push(question.q);
        console.log(`  [parse failure] ${question.q}`);
        continue;
      }

      verdicts.push(verdict);
      const mark = `grounded ${glyph(verdict.grounded)} cited ${glyph(verdict.allClaimsCited)} unknown-handling ${glyph(verdict.handledUnknownCorrectly)}`;
      console.log(`  [${mark}] ${question.q}`);
      console.log(`    ${citations.length} of ${evidence.length} retrieved chunks cited — ${verdict.reasoning}`);
    }

    console.log('\n| Dimension              | Rate |');
    console.log('|-------------------------|------|');
    console.log(`| grounded                | ${average(verdicts.map((v) => (v.grounded ? 1 : 0))).toFixed(2).padStart(4)} |`);
    console.log(`| all claims cited        | ${average(verdicts.map((v) => (v.allClaimsCited ? 1 : 0))).toFixed(2).padStart(4)} |`);
    console.log(`| handled unknowns right  | ${average(verdicts.map((v) => (v.handledUnknownCorrectly ? 1 : 0))).toFixed(2).padStart(4)} |`);

    if (parseFailures.length > 0) {
      console.log(`\n${parseFailures.length} judge response(s) failed to parse and were excluded from the rates above:`);
      for (const q of parseFailures) console.log(`  - ${q}`);
    }
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
