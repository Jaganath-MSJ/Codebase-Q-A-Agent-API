import { BadRequestException, Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import * as path from 'node:path';
import { ConfigService } from '../config/config.service';
import { CredentialsService } from '../credentials/credentials.service';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import type { ProjectRow } from '../db/schema';
import { ASKPASS_TOKEN_ENV_VAR, ensureAskpassScript } from './git-askpass';
import {
  cloneRepo,
  currentRevision,
  GITHUB_URL_RE,
  refreshRepo,
  resolveDefaultBranch,
  SAFE_BRANCH_RE,
  setCleanRemoteUrl,
} from './git-clone';
import type {
  MaterializeResult,
  SourceAdapter,
  SourceKind,
} from './source-adapter.interface';

@Injectable()
export class GitPrivateAdapter implements SourceAdapter {
  readonly kind: SourceKind = 'git_private';

  constructor(
    private readonly config: ConfigService,
    private readonly projectsRepository: ProjectsRepository,
    private readonly credentialsService: CredentialsService,
  ) {}

  /**
   * Identical to GitUrlAdapter's clone/refresh/revision mechanics (shared
   * via sources/git-clone.ts) — the only difference is the git subprocess's
   * environment. The token never appears in the URL, in argv, or on disk:
   * GIT_ASKPASS points at a static helper script (git-askpass.ts) that
   * prints whatever CQA_GIT_ASKPASS_TOKEN holds, and that env var is set
   * only for the duration of these calls. GIT_TERMINAL_PROMPT=0 means a bad
   * token fails fast with a clear git error instead of hanging on an
   * interactive prompt that will never come.
   */
  async materialize(project: ProjectRow): Promise<MaterializeResult> {
    const url = project.sourceRef;
    if (!GITHUB_URL_RE.test(url)) {
      throw new BadRequestException(`Not a valid GitHub HTTPS URL: ${url}`);
    }

    const token = await this.credentialsService.getToken(project.id);
    if (!token) {
      throw new BadRequestException(
        `Project ${project.id} has no stored credential — set one via PUT /api/projects/${project.id}/credential`,
      );
    }

    const askpassPath = await ensureAskpassScript(this.config.dataDir);
    const env = {
      GIT_ASKPASS: askpassPath,
      [ASKPASS_TOKEN_ENV_VAR]: token,
      GIT_TERMINAL_PROMPT: '0',
    };

    const workspacePath = this.workspacePathFor(project.id);

    let branch = project.defaultBranch;
    if (!branch) {
      branch = await resolveDefaultBranch(url, env);
      await this.projectsRepository.update(project.id, {
        defaultBranch: branch,
      });
    }
    if (!SAFE_BRANCH_RE.test(branch)) {
      throw new BadRequestException(`Not a valid branch name: ${branch}`);
    }

    if (existsSync(path.join(workspacePath, '.git'))) {
      await refreshRepo(workspacePath, branch, env);
    } else {
      await cloneRepo(url, branch, workspacePath, env);
    }
    await setCleanRemoteUrl(workspacePath, url);

    const revision = await currentRevision(workspacePath);
    return { workspacePath, revision };
  }

  async cleanup(project: ProjectRow): Promise<void> {
    await rm(this.workspacePathFor(project.id), {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 200,
    });
  }

  private workspacePathFor(projectId: string): string {
    return path.join(this.config.dataDir, 'workspaces', projectId);
  }
}
