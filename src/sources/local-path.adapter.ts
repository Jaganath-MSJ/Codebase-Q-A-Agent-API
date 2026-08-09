import { Injectable, NotFoundException } from '@nestjs/common';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { sha256 } from '../common/hash';
import type { ProjectRow } from '../db/schema';
import type { MaterializeResult, SourceAdapter, SourceKind } from './source-adapter.interface';

@Injectable()
export class LocalPathAdapter implements SourceAdapter {
  readonly kind: SourceKind = 'local_path';

  async materialize(project: ProjectRow): Promise<MaterializeResult> {
    const workspacePath = project.sourceRef;

    try {
      await access(workspacePath, fsConstants.R_OK);
    } catch {
      throw new NotFoundException(`Local path is not readable: ${workspacePath}`);
    }

    // A real per-file hash (file list + mtimes) isn't consumed until the
    // revision-tracking early exit lands in slice 4.2 — computing it here would
    // mean a second full tree walk on every index, duplicating the one
    // WalkerService is about to do. Stand in with a single root-level stat.
    const { mtimeMs } = await stat(workspacePath);
    return { workspacePath, revision: sha256(`${workspacePath}:${mtimeMs}`) };
  }

  async cleanup(): Promise<void> {
    // The workspace *is* the user's own folder — never delete it.
  }
}
