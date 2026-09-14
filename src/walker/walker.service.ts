import { Injectable } from '@nestjs/common';
import fg from 'fast-glob';
import { isBinaryFile } from 'isbinaryfile';
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { toPosix } from '../common/paths';
import { toLines } from '../common/read-file';
import { mapWithConcurrency } from '../common/concurrency';
import {
  classifyExtension,
  DENYLIST_PREFIXES,
  hasExcessiveLineLength,
  isDenylisted,
  isFilenameDenylisted,
  MAX_FILE_BYTES,
} from './filters';
import { loadGitignoreFilter } from './gitignore';

interface WalkedFile {
  relPath: string;
  absPath: string;
  // Read once here (Phase 12.6) so the indexer doesn't re-read from disk. The
  // CRLF→LF normalization goes through read-file.ts's `toLines`, so `text` is
  // byte-identical to a `readSourceFile` and `contentHash` never spuriously
  // changes. The indexer releases these per-entry after chunking to bound memory.
  text: string;
  lines: string[];
}

type SkipReason =
  'gitignore' | 'filename' | 'extension' | 'too-large' | 'binary' | 'minified';

interface WalkResult {
  included: WalkedFile[];
  skipReasons: Partial<Record<SkipReason, number>>;
}

// Passed to fast-glob's own `ignore` so it never recurses into these
// directories at all — the actual win (sidesteps the Windows 260-char path
// limit, and is the single biggest performance lever in the whole pipeline).
const DENYLIST_GLOBS = DENYLIST_PREFIXES.map((prefix) => `**/${prefix}**`);

// Bounded so a large repo doesn't exhaust file descriptors (EMFILE) or hold too
// many buffers at once; within the doc's 8–16 range.
const WALK_CONCURRENCY = 12;

// Per-entry outcome. 'skip-silent' is the denylist belt-and-suspenders case,
// which (like the original loop) is not counted in skipReasons.
type ClassifyResult =
  | { kind: 'include'; file: WalkedFile }
  | { kind: 'skip'; reason: SkipReason }
  | { kind: 'skip-silent' };

@Injectable()
export class WalkerService {
  async walk(rootDir: string): Promise<WalkResult> {
    const [entries, gitignoreEntries] = await Promise.all([
      fg('**/*', {
        cwd: rootDir,
        dot: true,
        onlyFiles: true,
        ignore: DENYLIST_GLOBS,
      }),
      fg('**/.gitignore', { cwd: rootDir, dot: true, ignore: DENYLIST_GLOBS }),
    ]);

    const gitignoreFilter = await loadGitignoreFilter(
      rootDir,
      gitignoreEntries,
    );

    // Classify entries concurrently (the stat/read/binary-sniff I/O is the walk's
    // cost), then aggregate sequentially so skipReasons totals and the included
    // ordering are deterministic regardless of completion order.
    const classify = async (entry: string): Promise<ClassifyResult> => {
      const relPath = toPosix(entry);

      // Belt-and-suspenders: fast-glob's `ignore` above already excludes these
      // paths from `entries` entirely; this guards only against a glob-pattern
      // edge case (e.g. a directory name fast-glob's matcher treats
      // differently than a plain prefix check would).
      if (isDenylisted(relPath)) return { kind: 'skip-silent' };
      if (gitignoreFilter.isIgnored(relPath))
        return { kind: 'skip', reason: 'gitignore' };
      if (isFilenameDenylisted(relPath))
        return { kind: 'skip', reason: 'filename' };
      if (classifyExtension(relPath) === 'denied')
        return { kind: 'skip', reason: 'extension' };

      const absPath = path.join(rootDir, entry);
      const stats = await stat(absPath);
      if (stats.size > MAX_FILE_BYTES)
        return { kind: 'skip', reason: 'too-large' };

      // One read: the raw buffer feeds the byte-level binary sniff; its utf8
      // decode feeds the minified check and read-file.ts's normalization.
      const buf = await readFile(absPath);
      if (await isBinaryFile(buf)) return { kind: 'skip', reason: 'binary' };

      const raw = buf.toString('utf8');
      if (hasExcessiveLineLength(raw))
        return { kind: 'skip', reason: 'minified' };

      const { text, lines } = toLines(raw);
      return { kind: 'include', file: { relPath, absPath, text, lines } };
    };

    const results = await mapWithConcurrency(
      entries,
      WALK_CONCURRENCY,
      classify,
    );

    const included: WalkedFile[] = [];
    const skipReasons: Partial<Record<SkipReason, number>> = {};
    for (const result of results) {
      if (result.kind === 'include') included.push(result.file);
      else if (result.kind === 'skip')
        skipReasons[result.reason] = (skipReasons[result.reason] ?? 0) + 1;
    }
    included.sort((a, b) =>
      a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
    );

    return { included, skipReasons };
  }
}
