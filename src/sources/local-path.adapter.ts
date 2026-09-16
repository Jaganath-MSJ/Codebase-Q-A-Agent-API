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
// The hash is (size, mtime, ctime, ino) per file, not content. It began as
// (size, mtime) alone, which was cheap but not airtight: a tool that preserves
// timestamps (zip extraction, some sync/restore flows) could leave a changed
// file with an identical (size, mtime) and the early exit would skip it —
// DEF-008. `ctime` closes that, since the OS bumps it on every write and no
// API can restore it, and `ino` catches a replace-by-rename.
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
        // `ctimeMs` and `ino` close DEF-008 without giving up the early exit.
        // mtime alone is forgeable: `utimes` restores it, so a same-size edit
        // made by an mtime-preserving tool (rsync -a, cp -p, zip extraction,
        // a restore) used to produce an identical revision and leave a stale
        // index reporting as healthy. `ctime` is the inode's change time —
        // the OS bumps it on any write and no API can set it back — and `ino`
        // catches a replace-by-rename. Still metadata only, so this stays far
        // cheaper than the content hash the diff loop pays for right after.
        //
        // The trade-off is deliberately inverted: a metadata-only touch (a
        // chmod, a restore that allocates a new inode) now costs one extra
        // diff pass that finds nothing. A false re-index is cheap; a silently
        // stale index is not.
        const { size, mtimeMs, ctimeMs, ino } = await stat(
          path.join(workspacePath, relPath),
        );
        // `ctimeMs` keeps its full precision deliberately — rounding it to the
        // millisecond throws away exactly the resolution this depends on, and a
        // rewrite that lands inside the same tick as the previous one would go
        // back to being invisible. mtime stays rounded: it is the field the
        // trick restores anyway, so its precision buys nothing.
        return `${relPath}:${size}:${Math.round(mtimeMs)}:${ctimeMs}:${ino}`;
      }),
    );

    return { workspacePath, revision: sha256(entryStats.join('\n')) };
  }

  async cleanup(): Promise<void> {
    // The workspace *is* the user's own folder — never delete it.
  }
}
