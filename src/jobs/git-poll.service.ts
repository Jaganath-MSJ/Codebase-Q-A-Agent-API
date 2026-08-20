import { ConflictException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { CredentialsService } from '../credentials/credentials.service';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import type { ProjectRow } from '../db/schema';
import { JobsService } from './jobs.service';
import { ASKPASS_TOKEN_ENV_VAR, ensureAskpassScript } from '../sources/git-askpass';
import { remoteHeadSha, type GitEnv } from '../sources/git-clone';

// A network round trip to an external remote, not a local fs event — the
// doc's "debounce hard, 30 seconds minimum" is about the local_path watcher's
// per-keystroke risk, which doesn't apply here. 5 minutes is frequent enough
// to feel automatic within a session without hammering the remote.
const POLL_INTERVAL_MS = 5 * 60_000;

/**
 * The other half of "automatic re-index on change" (the local_path half is
 * `WatcherService`) — for `git_url`/`git_private` projects, periodically
 * checks the remote's HEAD sha via a plain ref advertisement (no fetch, no
 * local clone touched) and auto-enqueues a re-index only when it moved.
 * Deliberately a sibling service, not folded into `WatcherService`: the two
 * mechanisms don't share a resource-cleanup shape (an `FSWatcher` handle per
 * project vs. nothing to close here), and only this one needs
 * `CredentialsService`.
 */
@Injectable()
export class GitPollService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GitPollService.name);
  private poll?: NodeJS.Timeout;

  constructor(
    private readonly projectsRepository: ProjectsRepository,
    private readonly jobsService: JobsService,
    private readonly credentialsService: CredentialsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    void this.checkAll();
    this.poll = setInterval(() => void this.checkAll(), POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.poll);
  }

  private async checkAll(): Promise<void> {
    const projects = await this.projectsRepository.findAll();
    const qualifying = projects.filter(
      (p) => (p.sourceKind === 'git_url' || p.sourceKind === 'git_private') && p.headRevision !== null,
    );

    for (const project of qualifying) {
      try {
        await this.checkOne(project);
      } catch (err) {
        this.logger.warn(
          `Remote-head check failed for project ${project.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async checkOne(project: ProjectRow): Promise<void> {
    if (!project.defaultBranch) return;

    let env: GitEnv | undefined;
    if (project.sourceKind === 'git_private') {
      const token = await this.credentialsService.getToken(project.id);
      if (!token) return; // shouldn't happen for a project that indexed successfully, but don't crash if it does
      const askpassPath = await ensureAskpassScript(this.config.dataDir);
      env = { GIT_ASKPASS: askpassPath, [ASKPASS_TOKEN_ENV_VAR]: token, GIT_TERMINAL_PROMPT: '0' };
    }

    const remoteSha = await remoteHeadSha(project.sourceRef, project.defaultBranch, env);
    if (!remoteSha || remoteSha === project.headRevision) return;

    try {
      await this.jobsService.enqueue(project.id, 'git-poll');
      this.logger.log(`Remote head moved for project '${project.name}' — enqueued re-index`);
    } catch (err) {
      // Already has an active job — the next poll after it finishes will
      // notice the same move if this job doesn't already cover it.
      if (err instanceof ConflictException) return;
      throw err;
    }
  }
}
