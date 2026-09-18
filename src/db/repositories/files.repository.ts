import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../pool';
import { DB_TOKEN } from '../tokens';
import { chunks, files, FileRow, NewChunkRow, NewFileRow } from '../schema';

interface ExistingFile {
  id: string;
  path: string;
  contentHash: string;
}

@Injectable()
export class FilesRepository {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async insertMany(rows: NewFileRow[]): Promise<FileRow[]> {
    if (rows.length === 0) return [];
    return this.db.insert(files).values(rows).returning();
  }

  /**
   * Is this exact repo-relative path one the project actually indexed?
   *
   * The gate for DEF-015. A `files` row exists only for a path that survived
   * the walker's filtering, so this is precisely "the project indexed it" —
   * gitignored, binary and excluded files (`.env` among them) never get one.
   * Matching is exact, not normalised: every path a client can legitimately
   * send came from a citation or a search hit, and those are these same stored
   * strings.
   */
  async existsByPath(projectId: string, path: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.projectId, projectId), eq(files.path, path)))
      .limit(1);
    return row !== undefined;
  }

  async findAllByProjectId(projectId: string): Promise<ExistingFile[]> {
    return this.db
      .select({
        id: files.id,
        path: files.path,
        contentHash: files.contentHash,
      })
      .from(files)
      .where(eq(files.projectId, projectId));
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.delete(files).where(inArray(files.id, ids));
  }

  /**
   * Replaces one file and its chunks atomically: delete the old row (if any —
   * cascades to its chunks) and insert the new file + chunks with
   * embedding = NULL, all in one transaction. This is what makes a crash
   * mid-chunking safe to resume: at every instant a file's chunks match
   * exactly what `content_hash` says, never a half-written mix of old and new.
   */
  async replaceFile(
    projectId: string,
    existingId: string | undefined,
    file: Omit<NewFileRow, 'projectId'>,
    chunkRows: Omit<NewChunkRow, 'projectId' | 'fileId'>[],
  ): Promise<FileRow> {
    return this.db.transaction(async (tx) => {
      if (existingId) {
        await tx.delete(files).where(eq(files.id, existingId));
      }

      const [fileRow] = await tx
        .insert(files)
        .values({ ...file, projectId })
        .returning();
      if (!fileRow)
        throw new Error(`Failed to insert file row for ${file.path}`);

      if (chunkRows.length > 0) {
        await tx.insert(chunks).values(
          chunkRows.map((chunk) => ({
            ...chunk,
            projectId,
            fileId: fileRow.id,
          })),
        );
      }

      return fileRow;
    });
  }
}
