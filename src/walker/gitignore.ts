import ignore, { type Ignore } from 'ignore';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { toPosix } from '../common/paths';

interface IgnoreLevel {
  /** Repo-relative directory the `.gitignore`/`.cqaignore` lives in, '' for the root. */
  dir: string;
  ig: Ignore;
}

export interface GitignoreFilter {
  isIgnored(relPath: string): boolean;
}

/**
 * Loads every `.gitignore` under the root, plus a single project-level
 * `.cqaignore` at the root, into one filter. Each level's patterns are
 * matched only against paths inside that level's own directory and relative
 * to it — the correct gitignore scoping rule — rather than flattening
 * everything into one pattern set, which would break patterns like `*.log`
 * that are meant to match at any depth *within* their own directory only.
 */
export async function loadGitignoreFilter(
  rootDir: string,
  gitignoreRelPaths: string[],
): Promise<GitignoreFilter> {
  const levels: IgnoreLevel[] = [];

  for (const relPath of gitignoreRelPaths) {
    const posixPath = toPosix(relPath);
    const dir = path.posix.dirname(posixPath);
    const content = await readFile(path.join(rootDir, relPath), 'utf8');
    levels.push({ dir: dir === '.' ? '' : dir, ig: ignore().add(content) });
  }

  try {
    const cqaignore = await readFile(path.join(rootDir, '.cqaignore'), 'utf8');
    levels.push({ dir: '', ig: ignore().add(cqaignore) });
  } catch {
    // no project-level .cqaignore — fine, it's optional
  }

  return {
    isIgnored(relPath: string): boolean {
      for (const { dir, ig } of levels) {
        if (dir !== '' && relPath !== dir && !relPath.startsWith(`${dir}/`))
          continue;
        const relativeToLevel =
          dir === '' ? relPath : relPath.slice(dir.length + 1);
        if (relativeToLevel && ig.ignores(relativeToLevel)) return true;
      }
      return false;
    },
  };
}
