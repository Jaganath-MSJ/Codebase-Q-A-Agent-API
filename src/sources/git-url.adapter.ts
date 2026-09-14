import { BadRequestException, Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import * as path from 'node:path';
import { ConfigService } from '../config/config.service';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import type { ProjectRow } from '../db/schema';
import {
  cloneRepo,
  currentRevision,
  GITHUB_URL_RE,
  refreshRepo,
  resolveDefaultBranch,
  SAFE_BRANCH_RE,
} from './git-clone';
import type {
  MaterializeResult,
  SourceAdapter,
  SourceKind,
} from './source-adapter.interface';

@Injectable()
export class GitUrlAdapter implements SourceAdapter {
  readonly kind: SourceKind = 'git_url';

  constructor(
    private readonly config: ConfigService,
    private readonly projectsRepository: ProjectsRepository,
  ) {}

  async materialize(project: ProjectRow): Promise<MaterializeResult> {
    const url = project.sourceRef;
    if (!GITHUB_URL_RE.test(url)) {
      throw new BadRequestException(`Not a valid GitHub HTTPS URL: ${url}`);
    }

    const workspacePath = this.workspacePathFor(project.id);

    // Resolving the default branch is a network round trip (git ls-remote);
    // persisting it here — rather than returning it for IndexingService to
    // save alongside workspacePath/revision — is a narrow, adapter-owned
    // exception, since "which branch" is a git-specific concept the generic
    // SourceAdapter contract has no reason to know about.
    let branch = project.defaultBranch;
    if (!branch) {
      branch = await resolveDefaultBranch(url);
      await this.projectsRepository.update(project.id, {
        defaultBranch: branch,
      });
    }
    if (!SAFE_BRANCH_RE.test(branch)) {
      throw new BadRequestException(`Not a valid branch name: ${branch}`);
    }

    if (existsSync(path.join(workspacePath, '.git'))) {
      await refreshRepo(workspacePath, branch);
    } else {
      await cloneRepo(url, branch, workspacePath);
    }

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
