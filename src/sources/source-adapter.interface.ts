import type { ProjectRow } from '../db/schema';

export type SourceKind =
  'local_path' | 'git_url' | 'zip_upload' | 'git_private';

export interface MaterializeResult {
  workspacePath: string;
  /** Git sha, or a content-tree hash for non-git sources. */
  revision: string;
}

export interface SourceAdapter {
  readonly kind: SourceKind;
  /** Materialize the source into a workspace directory. Idempotent. */
  materialize(
    project: ProjectRow,
    signal?: AbortSignal,
  ): Promise<MaterializeResult>;
  cleanup(project: ProjectRow): Promise<void>;
}
