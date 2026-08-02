import { Injectable } from '@nestjs/common';
import fg from 'fast-glob';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { toPosix } from '../common/paths';
import { hasAllowedExtension, isDenylisted, MAX_FILE_BYTES } from './filters';

const MAX_FILES = 200;

export interface WalkedFile {
  relPath: string;
  absPath: string;
}

@Injectable()
export class WalkerService {
  async walk(rootDir: string): Promise<WalkedFile[]> {
    const entries = await fg('**/*', {
      cwd: rootDir,
      dot: true,
      onlyFiles: true,
    });

    const results: WalkedFile[] = [];

    for (const entry of entries) {
      const relPath = toPosix(entry);
      if (isDenylisted(relPath)) continue;
      if (!hasAllowedExtension(relPath)) continue;

      const absPath = path.join(rootDir, entry);
      const stats = await stat(absPath);
      if (stats.size > MAX_FILE_BYTES) continue;

      results.push({ relPath, absPath });
    }

    if (results.length > MAX_FILES) {
      throw new Error(
        `This repository has ${results.length} indexable files, over the Phase 1 limit of ${MAX_FILES}. ` +
          'Synchronous indexing only supports small repos for now — background indexing arrives in Phase 2.',
      );
    }

    return results;
  }
}
