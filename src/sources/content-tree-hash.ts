import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import fg from 'fast-glob';
import { toPosix } from '../common/paths';

export interface ContentTreeEntry {
  path: string;
  contentHash: string;
}

/**
 * PURE — order-independent by construction (sorted before hashing), so
 * re-extracting the identical zip into a fresh directory reproduces the
 * exact same revision. This is what a zip_upload project uses in place of
 * git's `rev-parse HEAD`: unlike a (size, mtime) hash (what LocalPathAdapter
 * uses), a content hash doesn't depend on when/where the archive was
 * extracted, only what's in it.
 */
export function hashContentTree(entries: ContentTreeEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const hash = createHash('sha256');
  for (const entry of sorted) hash.update(`${entry.path}:${entry.contentHash}\n`);
  return hash.digest('hex');
}

export async function hashWorkspaceContentTree(workspacePath: string): Promise<string> {
  const relPaths = await fg('**/*', { cwd: workspacePath, dot: true, onlyFiles: true });
  const entries = await Promise.all(
    relPaths.map(async (relPath): Promise<ContentTreeEntry> => {
      const buf = await readFile(path.join(workspacePath, relPath));
      return { path: toPosix(relPath), contentHash: createHash('sha256').update(buf).digest('hex') };
    }),
  );
  return hashContentTree(entries);
}
