import { pgTable, uuid, text, integer, timestamp } from 'drizzle-orm/pg-core';

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  sourceKind: text('source_kind').notNull().default('local_path'),
  sourceRef: text('source_ref').notNull(),
  status: text('status').notNull().default('created'),
  fileCount: integer('file_count').notNull().default(0),
  chunkCount: integer('chunk_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
