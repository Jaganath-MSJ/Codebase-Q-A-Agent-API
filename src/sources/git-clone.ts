import { mkdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { BadRequestException } from '@nestjs/common';
import simpleGit, { CleanOptions, type SimpleGit } from 'simple-git';

// https:// only, github.com only, owner/repo shape, no shell metacharacters —
// this string is about to be shelled out to via an argument array (never a
// command string), but it is still worth rejecting anything unexpected here.
export const GITHUB_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(?:\.git)?\/?$/;

// `branch` reaches `git fetch`/`git clone` as a bare positional argv entry
// (not a shell string, so no shell injection) — but a value starting with
// `-` is still a well-known argument-injection vector (e.g.
// `--upload-pack=...`) once anything other than plain HTTPS is involved.
// Reject anything that isn't a plausible git ref name.
export const SAFE_BRANCH_RE = /^(?!-)(?!.*\.\.)[\w./-]+$/;

// Extra environment variables merged into the git subprocess's env — this is
// how GitPrivateAdapter injects GIT_ASKPASS/GIT_TERMINAL_PROMPT without
// GitUrlAdapter (which never passes one) needing to know credentials exist.
export type GitEnv = Record<string, string>;

// The base env a git subprocess needs to run at all — deliberately a narrow
// allowlist, not the full `process.env`. Spreading everything inherited
// from this Node process pulled in stray dev-shell variables (observed:
// EDITOR) that simple-git's own safety net (below) also flags, for no
// reason relevant to a git clone/fetch/ls-remote.
const BASE_ENV_KEYS = [
  'PATH',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
];

function baseGitEnv(): GitEnv {
  const env: GitEnv = {};
  for (const key of BASE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function git(cwd?: string, env?: GitEnv) {
  // simple-git ships its own safety net (`@simple-git/argv-parser`'s
  // vulnerabilityCheck) that blocks GIT_ASKPASS by default, precisely
  // because a library consumer naively forwarding untrusted input into it
  // is a real code-execution vector — the exact class of bug this project's
  // security phase is about. `allowUnsafeAskPass` is the deliberate,
  // narrow opt-in for exactly this case: the askpass script path is always
  // this module's own static helper (git-askpass.ts), never user input.
  const options = env ? { unsafe: { allowUnsafeAskPass: true } } : undefined;
  const instance = cwd
    ? options
      ? simpleGit(cwd, options)
      : simpleGit(cwd)
    : options
      ? simpleGit(options)
      : simpleGit();
  // simple-git's single-argument `.env(obj)` REPLACES the child process's
  // entire environment rather than merging into it (the two-argument
  // `.env(name, value)` form merges; this one doesn't), so the base env
  // above has to be included explicitly every time.
  return env ? instance.env({ ...baseGitEnv(), ...env }) : instance;
}

export async function resolveDefaultBranch(url: string, env?: GitEnv): Promise<string> {
  const raw = await git(undefined, env).listRemote(['--symref', url, 'HEAD']);
  const match = /ref:\s+refs\/heads\/(\S+)\s+HEAD/.exec(raw);
  if (!match) throw new BadRequestException(`Could not determine the default branch for ${url}`);
  return match[1]!;
}

export async function cloneRepo(url: string, branch: string, dest: string, env?: GitEnv): Promise<void> {
  await rm(dest, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  await mkdir(path.dirname(dest), { recursive: true });
  await git(undefined, env).clone(url, dest, [
    '--depth',
    '1',
    '--filter=blob:none',
    '--single-branch',
    '--branch',
    branch,
  ]);
}

export async function refreshRepo(dest: string, branch: string, env?: GitEnv): Promise<void> {
  const instance = git(dest, env);
  await instance.fetch('origin', branch, ['--depth', '1']);
  await instance.reset(['--hard', 'FETCH_HEAD']);
  await instance.clean(CleanOptions.FORCE + CleanOptions.RECURSIVE + CleanOptions.IGNORED_INCLUDED);
}

/**
 * Defense in depth for GitPrivateAdapter: the token is never embedded in the
 * clone URL to begin with (GIT_ASKPASS supplies it out of band), but
 * resetting the remote to a known-clean URL right after cloning guarantees
 * nothing credential-bearing can persist in .git/config even if something
 * upstream ever rewrote it.
 */
export async function setCleanRemoteUrl(dest: string, url: string): Promise<void> {
  await simpleGit(dest).remote(['set-url', 'origin', url]);
}

export async function currentRevision(dest: string): Promise<string> {
  return (await simpleGit(dest).revparse(['HEAD'])).trim();
}

export interface ChangedFile {
  path: string;
  insertions: number;
  deletions: number;
  binary: boolean;
  patch: string;
}

export interface LastCommitInfo {
  hash: string;
  message: string;
  authorName: string;
  date: string;
  files: ChangedFile[];
}

/**
 * `cloneRepo`/`refreshRepo` both fetch `--depth 1` — plenty for indexing
 * (which only ever needs the current tree), but it means a fresh or
 * just-refreshed clone has no `HEAD~1` to diff against at all. Deepens by
 * exactly one commit, on demand, only when this feature actually needs it —
 * the indexing path's own depth is left untouched.
 */
async function ensurePriorCommitAvailable(instance: SimpleGit): Promise<boolean> {
  try {
    await instance.revparse(['HEAD~1']);
    return true;
  } catch {
    try {
      await instance.fetch(['--deepen=1']);
      await instance.revparse(['HEAD~1']);
      return true;
    } catch {
      return false;
    }
  }
}

/** Null when there's no prior commit to diff against (a brand-new repo, or the deepen fetch itself failed). */
export async function lastCommitDiff(dest: string): Promise<LastCommitInfo | null> {
  const instance = git(dest);
  if (!(await ensurePriorCommitAvailable(instance))) return null;

  const log = await instance.log({ maxCount: 1 });
  if (!log.latest) return null;

  const summary = await instance.diffSummary(['HEAD~1']);
  const files: ChangedFile[] = [];
  for (const file of summary.files) {
    if (file.binary) {
      files.push({ path: file.file, insertions: 0, deletions: 0, binary: true, patch: '' });
      continue;
    }
    const patch = await instance.diff(['HEAD~1', '--', file.file]);
    files.push({ path: file.file, insertions: file.insertions, deletions: file.deletions, binary: false, patch });
  }

  return {
    hash: log.latest.hash,
    message: log.latest.message,
    authorName: log.latest.author_name,
    date: log.latest.date,
    files,
  };
}
