import { Injectable, NotFoundException } from '@nestjs/common';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import * as path from 'node:path';
import fg from 'fast-glob';
import { sha256 } from '../common/hash';
import type { ProjectRow } from '../db/schema';
import type {
  MaterializeResult,
  SourceAdapter,
  SourceKind,
} from './source-adapter.interface';

// A coarse exclusion list, deliberately not WalkerService's full gitignore/
// binary/filename filtering (Sources is a sibling capability module and
// shouldn't depend on Walker's rules). Being coarser only means the revision
// changes when it doesn't strictly need to (an unindexed file was touched).
//
// The hash is (size, mtime) per file, not content — cheap, but not airtight:
// a tool that preserves timestamps (zip extraction, some sync/restore flows)
// could in principle leave a changed file with an identical (size, mtime).
// A true content hash would mean reading every file, which is exactly the
// per-file cost IndexingService's diff loop already pays right after this —
// the early exit would have nothing left to skip. This also means every run
// that actually needs to walk (not just the unchanged/early-exit case) now
// pays for two full directory scans — this one, then WalkerService's own —
// a real cost accepted in exchange for skipping both entirely when nothing
// changed. See docs/PROGRESS.md for the tradeoff this was weighed against in 4.1.
export const REVISION_IGNORE_GLOBS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
];

@Injectable()
export class LocalPathAdapter implements SourceAdapter {
  readonly kind: SourceKind = 'local_path';

  async materialize(project: ProjectRow): Promise<MaterializeResult> {
    const workspacePath = project.sourceRef;

    try {
      await access(workspacePath, fsConstants.R_OK);
    } catch {
      throw new NotFoundException(
        `Local path is not readable: ${workspacePath}`,
      );
    }

    const entries = await fg('**/*', {
      cwd: workspacePath,
      dot: true,
      onlyFiles: true,
      ignore: REVISION_IGNORE_GLOBS,
    });
    entries.sort((a, b) => a.localeCompare(b));

    const entryStats = await Promise.all(
      entries.map(async (relPath) => {
        const { size, mtimeMs } = await stat(path.join(workspacePath, relPath));
        return `${relPath}:${size}:${Math.round(mtimeMs)}`;
      }),
    );

    return { workspacePath, revision: sha256(entryStats.join('\n')) };
  }

  async cleanup(): Promise<void> {
    // The workspace *is* the user's own folder — never delete it.
  }
}
