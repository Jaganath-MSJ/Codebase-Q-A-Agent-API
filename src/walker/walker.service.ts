import { Injectable } from '@nestjs/common';
import fg from 'fast-glob';
import { isBinaryFile } from 'isbinaryfile';
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { toPosix } from '../common/paths';
import {
  classifyExtension,
  DENYLIST_PREFIXES,
  hasExcessiveLineLength,
  isDenylisted,
  isFilenameDenylisted,
  MAX_FILE_BYTES,
} from './filters';
import { loadGitignoreFilter } from './gitignore';

export interface WalkedFile {
  relPath: string;
  absPath: string;
}

export type SkipReason = 'gitignore' | 'filename' | 'extension' | 'too-large' | 'binary' | 'minified';

export interface WalkResult {
  included: WalkedFile[];
  skipReasons: Partial<Record<SkipReason, number>>;
}

// Passed to fast-glob's own `ignore` so it never recurses into these
// directories at all — the actual win (sidesteps the Windows 260-char path
// limit, and is the single biggest performance lever in the whole pipeline).
const DENYLIST_GLOBS = DENYLIST_PREFIXES.map((prefix) => `**/${prefix}**`);

@Injectable()
export class WalkerService {
  async walk(rootDir: string): Promise<WalkResult> {
    const [entries, gitignoreEntries] = await Promise.all([
      fg('**/*', { cwd: rootDir, dot: true, onlyFiles: true, ignore: DENYLIST_GLOBS }),
      fg('**/.gitignore', { cwd: rootDir, dot: true, ignore: DENYLIST_GLOBS }),
    ]);

    const gitignoreFilter = await loadGitignoreFilter(rootDir, gitignoreEntries);

    const included: WalkedFile[] = [];
    const skipReasons: Partial<Record<SkipReason, number>> = {};
    const bump = (reason: SkipReason): void => {
      skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
    };

    for (const entry of entries) {
      const relPath = toPosix(entry);

      // Belt-and-suspenders: fast-glob's `ignore` above already excludes these
      // paths from `entries` entirely; this guards only against a glob-pattern
      // edge case (e.g. a directory name fast-glob's matcher treats
      // differently than a plain prefix check would).
      if (isDenylisted(relPath)) continue;

      if (gitignoreFilter.isIgnored(relPath)) {
        bump('gitignore');
        continue;
      }
      if (isFilenameDenylisted(relPath)) {
        bump('filename');
        continue;
      }

      if (classifyExtension(relPath) === 'denied') {
        bump('extension');
        continue;
      }

      const absPath = path.join(rootDir, entry);
      const stats = await stat(absPath);
      if (stats.size > MAX_FILE_BYTES) {
        bump('too-large');
        continue;
      }

      const buf = await readFile(absPath);
      if (await isBinaryFile(buf)) {
        bump('binary');
        continue;
      }

      if (hasExcessiveLineLength(buf.toString('utf8'))) {
        bump('minified');
        continue;
      }

      included.push({ relPath, absPath });
    }

    return { included, skipReasons };
  }
}
