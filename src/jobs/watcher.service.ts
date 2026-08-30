import { ConflictException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { watch, type FSWatcher } from 'node:fs';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import { JobsService } from './jobs.service';
import { REVISION_IGNORE_GLOBS } from '../sources/local-path.adapter';
import { matchesGlob } from '../common/glob';
import { toPosix } from '../common/paths';
import type { ProjectRow } from '../db/schema';

// The doc's own stated minimum — collapses a burst of saves (an editor's
// autosave, a `git checkout`, a build writing dist/ before it's excluded)
// into one re-index instead of one per file-change event.
const WATCH_DEBOUNCE_MS = 30_000;
// How often to notice a new local_path project (or a deleted one) — cheap
// (one small-table `SELECT *`), unlike the per-keystroke DB polling this
// project has already rejected once (Phase 2). Not the file-content watch
// itself, which is push-based (fs.watch), not polled.
const PROJECT_POLL_MS = 60_000;

interface WatchEntry {
  watcher: FSWatcher;
  debounceTimer?: NodeJS.Timeout;
}

/**
 * Watches every already-indexed `local_path` project's workspace and
 * auto-enqueues a re-index (debounced) when a file changes — Phase 4's
 * revision early exit means a burst of saves that nets out to no real change
 * (e.g. an editor writing then reverting) still costs only a cheap walk, not
 * a full re-embed. `git_url`/`git_private` projects are handled by the
 * sibling `GitPollService` instead (periodic remote-head check, not a
 * filesystem event); `zip_upload` has neither a live folder nor a remote to
 * watch, so it has no auto-reindex mechanism at all.
 */
@Injectable()
export class WatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WatcherService.name);
  private readonly watched = new Map<string, WatchEntry>();
  private projectPoll?: NodeJS.Timeout;

  constructor(
    private readonly projectsRepository: ProjectsRepository,
    private readonly jobsService: JobsService,
  ) {}

  onModuleInit(): void {
    void this.syncWatchedProjects();
    this.projectPoll = setInterval(() => void this.syncWatchedProjects(), PROJECT_POLL_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.projectPoll);
    for (const entry of this.watched.values()) {
      clearTimeout(entry.debounceTimer);
      entry.watcher.close();
    }
    this.watched.clear();
  }

  private async syncWatchedProjects(): Promise<void> {
    let projects: ProjectRow[];
    try {
      projects = await this.projectsRepository.findAll();
    } catch (err) {
      // Called unawaited from a setInterval — an uncaught rejection here would
      // crash the whole process on a transient Neon blip (this project's notes
      // already document these as routine, e.g. ETIMEDOUT/ENOTFOUND). Skip this
      // cycle; the next poll (or a fresh `job.created` wake) tries again.
      this.logger.warn(`Project poll failed, will retry next cycle: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // `headRevision` is only set once a project has indexed successfully at
    // least once — watching a never-indexed project would just auto-trigger
    // the *first* index before the user has ever pressed "Index" themselves.
    const qualifying = new Map(
      projects.filter((p) => p.sourceKind === 'local_path' && p.headRevision !== null).map((p) => [p.id, p]),
    );

    for (const [id, entry] of this.watched) {
      if (qualifying.has(id)) continue;
      clearTimeout(entry.debounceTimer);
      entry.watcher.close();
      this.watched.delete(id);
    }

    for (const [id, project] of qualifying) {
      if (!this.watched.has(id)) this.startWatching(project);
    }
  }

  private startWatching(project: ProjectRow): void {
    const root = project.workspacePath ?? project.sourceRef;
    let watcher: FSWatcher;
    try {
      watcher = watch(root, { recursive: true }, (_eventType, filename) => {
        if (filename && REVISION_IGNORE_GLOBS.some((glob) => matchesGlob(toPosix(filename), glob))) return;
        this.scheduleReindex(project.id);
      });
    } catch (err) {
      this.logger.warn(
        `Could not watch '${root}' for project ${project.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    watcher.on('error', (err) => {
      this.logger.warn(`Watcher error for project ${project.id}: ${err.message}`);
    });
    this.watched.set(project.id, { watcher });
    this.logger.log(`Watching '${root}' for project '${project.name}' (auto re-index on change)`);
  }

  private scheduleReindex(projectId: string): void {
    const entry = this.watched.get(projectId);
    if (!entry) return;
    clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => void this.triggerReindex(projectId), WATCH_DEBOUNCE_MS);
  }

  private async triggerReindex(projectId: string): Promise<void> {
    try {
      await this.jobsService.enqueue(projectId, 'watch');
    } catch (err) {
      // Already has an active job — the change will still be picked up,
      // either by that job (if it hasn't materialized yet) or the next
      // debounce cycle after it finishes.
      if (err instanceof ConflictException) return;
      this.logger.warn(
        `Auto re-index enqueue failed for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
