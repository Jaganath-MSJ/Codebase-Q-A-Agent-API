import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Db } from '../pool';
import { DB_TOKEN } from '../tokens';
import { sourceCredentials, SourceCredentialRow, NewSourceCredentialRow } from '../schema';

@Injectable()
export class CredentialsRepository {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /** Re-entering a token replaces the row rather than adding a second one. */
  async upsert(
    data: Pick<NewSourceCredentialRow, 'projectId' | 'kind' | 'ciphertext' | 'iv' | 'authTag'>,
  ): Promise<SourceCredentialRow> {
    const [row] = await this.db
      .insert(sourceCredentials)
      .values(data)
      .onConflictDoUpdate({
        target: sourceCredentials.projectId,
        set: {
          kind: data.kind,
          ciphertext: data.ciphertext,
          iv: data.iv,
          authTag: data.authTag,
          createdAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error('Upsert returned no row');
    return row;
  }

  async findByProjectId(projectId: string): Promise<SourceCredentialRow | undefined> {
    const [row] = await this.db
      .select()
      .from(sourceCredentials)
      .where(eq(sourceCredentials.projectId, projectId));
    return row;
  }

  async deleteByProjectId(projectId: string): Promise<boolean> {
    const result = await this.db
      .delete(sourceCredentials)
      .where(eq(sourceCredentials.projectId, projectId))
      .returning({ id: sourceCredentials.id });
    return result.length > 0;
  }
}
