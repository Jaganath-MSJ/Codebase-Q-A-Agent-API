export interface Chunk {
  ord: number;
  startLine: number;
  endLine: number;
  content: string;
  /** Qualified name (e.g. "AuthService.validateUser") — undefined when none applies. */
  symbol?: string;
}

export interface Chunker {
  chunk(lines: string[], lang?: string | null): Chunk[];
}

/**
 * Participates in files.contentHash (see indexing.service.ts) so a version
 * bump invalidates every file's "unchanged" check exactly once, forcing a
 * full re-chunk without needing to touch any file's actual content. Bump
 * this whenever chunk boundaries could change for files that otherwise
 * look unchanged — e.g. swapping the chunking algorithm itself.
 */
export const CHUNKER_VERSION = 2;
