import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { performance } from 'node:perf_hooks';
import { ConfigModule } from '../src/config/config.module';
import { DbModule } from '../src/db/db.module';
import { EventsModule } from '../src/events/events.module';
import { ProjectsRepository } from '../src/db/repositories/projects.repository';
import { FilesRepository } from '../src/db/repositories/files.repository';
import { IndexingModule } from '../src/indexing/indexing.module';
import { IndexingService, type IndexProgress } from '../src/indexing/indexing.service';

// Read-mostly indexing benchmark. Force-indexes a project cold (clearing its
// files first so every file re-chunks and every chunk re-embeds), timing each
// phase from `onProgress`, and reports total embedRequests, chunk count, and
// peak RSS — the pre-Phase-2 baseline for the throughput slices (12.5–12.10).
//
// It leaves the project fully indexed again on success. Pick a SMALL repo so the
// re-embed stays well under the 900/day budget:
//   npm run bench:index                 # default project
//   npm run bench:index -- "Readme"     # or: BENCH_PROJECT="Readme" npm run bench:index

const DEFAULT_PROJECT = 'Tiny Repo';
type Phase = IndexProgress['phase'];
const PHASE_ORDER: Phase[] = ['walking', 'chunking', 'embedding', 'finalizing'];

@Module({ imports: [ConfigModule, DbModule, EventsModule, IndexingModule] })
class BenchIndexModule {}

async function main(): Promise<void> {
  const projectName = process.argv[2] ?? process.env.BENCH_PROJECT ?? DEFAULT_PROJECT;

  const app = await NestFactory.createApplicationContext(BenchIndexModule, {
    logger: false,
    abortOnError: false,
  });

  // Sample RSS on an interval so the peak inside a long embed batch is caught,
  // not just at phase boundaries. Unref'd so it never keeps the process alive.
  let peakRss = process.memoryUsage().rss;
  const sampleRss = (): void => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  };
  const rssTimer = setInterval(sampleRss, 100);
  rssTimer.unref();

  try {
    const projectsRepository = app.get(ProjectsRepository);
    const filesRepository = app.get(FilesRepository);
    const indexingService = app.get(IndexingService);

    const allProjects = await projectsRepository.findAll();
    const project = allProjects.find((p) => p.name === projectName);
    if (!project) {
      const available =
        allProjects
          .map((p) => `'${p.name}' (${p.status}, ${p.fileCount} files, ${p.chunkCount} chunks)`)
          .join(', ') || '(none)';
      throw new Error(
        `No project named '${projectName}' found. Available: ${available}. ` +
          `Pass a small one with: npm run bench:index -- "<Project Name>".`,
      );
    }

    console.log(
      `\nbench-index · project '${project.name}' (${project.sourceKind}) · ` +
        `${project.fileCount} files / ${project.chunkCount} chunks · cold force-index\n`,
    );

    // Cold index: delete existing file rows (cascades to chunks + embeddings) so
    // the force-index re-walks, re-chunks, and re-embeds everything — the honest
    // from-scratch baseline. On failure the project is left partially indexed;
    // just re-run to restore it.
    const existing = await filesRepository.findAllByProjectId(project.id);
    await filesRepository.deleteByIds(existing.map((f) => f.id));
    console.log(`Cleared ${existing.length} file rows; forcing a full re-index...\n`);

    // Per-phase wall-clock from onProgress phase transitions.
    const phaseStart = new Map<Phase, number>();
    let lastPhase: Phase | null = null;
    let embedRequests = 0;

    const onProgress = (u: IndexProgress): void => {
      sampleRss();
      if (u.phase !== lastPhase) {
        phaseStart.set(u.phase, performance.now());
        lastPhase = u.phase;
      }
      if (u.embedRequests != null) embedRequests = u.embedRequests;
    };

    const t0 = performance.now();
    const result = await indexingService.indexProject(project.id, onProgress, undefined, true);
    const tEnd = performance.now();
    sampleRss();

    // Each phase runs until the next phase's first event; finalizing runs until
    // indexProject returns.
    const marks = PHASE_ORDER.filter((p) => phaseStart.has(p));
    console.log('| Phase       | wall-clock (ms) |');
    console.log('|-------------|-----------------|');
    for (let i = 0; i < marks.length; i++) {
      const start = phaseStart.get(marks[i]!)!;
      const end = i + 1 < marks.length ? phaseStart.get(marks[i + 1]!)! : tEnd;
      console.log(`| ${marks[i]!.padEnd(11)} | ${(end - start).toFixed(1).padStart(15)} |`);
    }
    console.log(`| ${'TOTAL'.padEnd(11)} | ${(tEnd - t0).toFixed(1).padStart(15)} |`);

    console.log('');
    console.log(`fileCount     : ${result.fileCount}`);
    console.log(`chunkCount    : ${result.chunkCount}`);
    console.log(`embedRequests : ${embedRequests}`);
    console.log(`peak RSS      : ${(peakRss / 1024 / 1024).toFixed(1)} MB`);
    console.log('');
  } finally {
    clearInterval(rssTimer);
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
