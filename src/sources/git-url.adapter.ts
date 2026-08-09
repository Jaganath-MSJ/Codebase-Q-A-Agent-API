import { BadRequestException, Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import simpleGit, { CleanOptions } from 'simple-git';
import { ConfigService } from '../config/config.service';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import type { ProjectRow } from '../db/schema';
import type { MaterializeResult, SourceAdapter, SourceKind } from './source-adapter.interface';

// https:// only, github.com only, owner/repo shape, no shell metacharacters —
// this string is about to be shelled out to via an argument array (never a
// command string), but it is still worth rejecting anything unexpected here.
const GITHUB_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(?:\.git)?\/?$/;

// `branch` reaches `git fetch`/`git clone` as a bare positional argv entry
// (not a shell string, so no shell injection) — but a value starting with
// `-` is still a well-known argument-injection vector (e.g.
// `--upload-pack=...`) once anything other than plain HTTPS is involved.
// Reject anything that isn't a plausible git ref name.
const SAFE_BRANCH_RE = /^(?!-)(?!.*\.\.)[\w./-]+$/;

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
      branch = await this.resolveDefaultBranch(url);
      await this.projectsRepository.update(project.id, { defaultBranch: branch });
    }
    if (!SAFE_BRANCH_RE.test(branch)) {
      throw new BadRequestException(`Not a valid branch name: ${branch}`);
    }

    if (existsSync(path.join(workspacePath, '.git'))) {
      await this.refresh(workspacePath, branch);
    } else {
      await this.clone(url, branch, workspacePath);
    }

    const revision = (await simpleGit(workspacePath).revparse(['HEAD'])).trim();
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

  private async resolveDefaultBranch(url: string): Promise<string> {
    const raw = await simpleGit().listRemote(['--symref', url, 'HEAD']);
    const match = /ref:\s+refs\/heads\/(\S+)\s+HEAD/.exec(raw);
    if (!match) throw new BadRequestException(`Could not determine the default branch for ${url}`);
    return match[1]!;
  }

  private async clone(url: string, branch: string, dest: string): Promise<void> {
    await rm(dest, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    await mkdir(path.dirname(dest), { recursive: true });
    await simpleGit().clone(url, dest, [
      '--depth',
      '1',
      '--filter=blob:none',
      '--single-branch',
      '--branch',
      branch,
    ]);
  }

  private async refresh(dest: string, branch: string): Promise<void> {
    const git = simpleGit(dest);
    await git.fetch('origin', branch, ['--depth', '1']);
    await git.reset(['--hard', 'FETCH_HEAD']);
    await git.clean(CleanOptions.FORCE + CleanOptions.RECURSIVE + CleanOptions.IGNORED_INCLUDED);
  }
}
