import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import * as path from 'node:path';
import { resolveUploadPath } from '../common/upload-id';
import { ConfigService } from '../config/config.service';
import type { ProjectRow } from '../db/schema';
import { hashWorkspaceContentTree } from './content-tree-hash';
import type { MaterializeResult, SourceAdapter, SourceKind } from './source-adapter.interface';
import { extractZipSafely } from './zip-extractor';

@Injectable()
export class ZipUploadAdapter implements SourceAdapter {
  readonly kind: SourceKind = 'zip_upload';

  constructor(private readonly config: ConfigService) {}

  /**
   * `project.sourceRef` is the uploadId returned from `POST /uploads`.
   * Extraction happens once, the first time this project is indexed — the
   * uploaded zip is deleted straight after (it's transient, per the data
   * layout doc), and every later call (a plain re-index) recomputes the
   * revision from the already-extracted workspace, exactly like
   * LocalPathAdapter re-walking its folder on every call.
   */
  async materialize(project: ProjectRow): Promise<MaterializeResult> {
    const workspacePath = this.workspacePathFor(project.id);

    if (!existsSync(workspacePath)) {
      let uploadPath: string;
      try {
        uploadPath = resolveUploadPath(path.join(this.config.dataDir, 'uploads'), project.sourceRef);
      } catch {
        throw new BadRequestException(`Not a valid uploadId: ${project.sourceRef}`);
      }
      if (!existsSync(uploadPath)) {
        throw new NotFoundException(
          `Upload ${project.sourceRef} not found — it may already have been extracted or expired`,
        );
      }
      await extractZipSafely(uploadPath, workspacePath);
      await rm(uploadPath, { force: true });
    }

    const revision = await hashWorkspaceContentTree(workspacePath);
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
}
