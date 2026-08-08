import { Inject, Injectable } from '@nestjs/common';
import { asc, inArray } from 'drizzle-orm';
import type { Db } from '../pool';
import { DB_TOKEN } from '../tokens';
import { citations, CitationRow, NewCitationRow } from '../schema';

@Injectable()
export class CitationsRepository {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /** One row per retrieved chunk, cited or not — this is the debugging surface, not bookkeeping. */
  async insertMany(rows: NewCitationRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(citations).values(rows);
  }

  async findAllByMessageIds(messageIds: string[]): Promise<CitationRow[]> {
    if (messageIds.length === 0) return [];
    return this.db
      .select()
      .from(citations)
      .where(inArray(citations.messageId, messageIds))
      .orderBy(asc(citations.marker));
  }
}
