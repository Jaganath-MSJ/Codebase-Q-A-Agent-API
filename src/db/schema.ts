import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  vector,
  unique,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  sourceKind: text('source_kind').notNull().default('local_path'),
  sourceRef: text('source_ref').notNull(),
  status: text('status').notNull().default('created'),
  fileCount: integer('file_count').notNull().default(0),
  chunkCount: integer('chunk_count').notNull().default(0),
  embeddingModel: text('embedding_model'),
  embeddingDim: integer('embedding_dim'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    lang: text('lang'),
    contentHash: text('content_hash').notNull(),
    lineCount: integer('line_count').notNull(),
  },
  (table) => [unique().on(table.projectId, table.path)],
);

export type FileRow = typeof files.$inferSelect;
export type NewFileRow = typeof files.$inferInsert;

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    ord: integer('ord').notNull(),
    startLine: integer('start_line').notNull(),
    endLine: integer('end_line').notNull(),
    content: text('content').notNull(),
    contentHash: text('content_hash').notNull(),
    embedding: vector('embedding', { dimensions: 768 }),
  },
  (table) => [unique().on(table.fileId, table.ord)],
);

export type ChunkRow = typeof chunks.$inferSelect;
export type NewChunkRow = typeof chunks.$inferInsert;

export const indexingJobs = pgTable(
  'indexing_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('queued'),
    trigger: text('trigger').notNull().default('initial'),
    filesTotal: integer('files_total').notNull().default(0),
    filesDone: integer('files_done').notNull().default(0),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'indexing_jobs_status_check',
      sql`${table.status} IN ('queued','running','succeeded','failed','canceled')`,
    ),
    index('indexing_jobs_status_created_idx').on(table.status, table.createdAt),
    uniqueIndex('one_active_job_per_project')
      .on(table.projectId)
      .where(sql`${table.status} IN ('queued','running')`),
  ],
);

export type IndexingJobRow = typeof indexingJobs.$inferSelect;
export type NewIndexingJobRow = typeof indexingJobs.$inferInsert;
