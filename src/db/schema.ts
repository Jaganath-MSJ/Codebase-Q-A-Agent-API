import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  timestamp,
  vector,
  unique,
  uniqueIndex,
  index,
  check,
  boolean,
  jsonb,
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
    phase: text('phase'),
    trigger: text('trigger').notNull().default('initial'),
    filesTotal: integer('files_total').notNull().default(0),
    filesDone: integer('files_done').notNull().default(0),
    filesSkipped: integer('files_skipped').notNull().default(0),
    skipReasons: jsonb('skip_reasons').notNull().default({}).$type<Record<string, number>>(),
    chunksTotal: integer('chunks_total').notNull().default(0),
    chunksEmbedded: integer('chunks_embedded').notNull().default(0),
    embedRequests: integer('embed_requests').notNull().default(0),
    currentPath: text('current_path'),
    attempt: integer('attempt').notNull().default(1),
    maxAttempts: integer('max_attempts').notNull().default(3),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'indexing_jobs_status_check',
      sql`${table.status} IN ('queued','running','succeeded','failed','canceled','paused')`,
    ),
    check(
      'indexing_jobs_phase_check',
      sql`${table.phase} IN ('acquiring','walking','chunking','embedding','finalizing')`,
    ),
    index('indexing_jobs_status_created_idx').on(table.status, table.createdAt),
    uniqueIndex('one_active_job_per_project')
      .on(table.projectId)
      .where(sql`${table.status} IN ('queued','running','paused')`),
  ],
);

export type IndexingJobRow = typeof indexingJobs.$inferSelect;
export type NewIndexingJobRow = typeof indexingJobs.$inferInsert;

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ConversationRow = typeof conversations.$inferSelect;
export type NewConversationRow = typeof conversations.$inferInsert;

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull().default(''),
    status: text('status').notNull().default('complete'),
    provider: text('provider'),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    latencyMs: integer('latency_ms'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('messages_role_check', sql`${table.role} IN ('user','assistant')`),
    check(
      'messages_status_check',
      sql`${table.status} IN ('pending','streaming','complete','error')`,
    ),
    index('messages_conversation_created_idx').on(table.conversationId, table.createdAt),
  ],
);

export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;

export const citations = pgTable(
  'citations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    marker: integer('marker').notNull(),
    chunkId: uuid('chunk_id').references(() => chunks.id, { onDelete: 'set null' }),
    // Denormalized snapshot: survives re-indexing, so old conversations keep
    // readable citations even after the live chunk row is gone.
    filePath: text('file_path').notNull(),
    startLine: integer('start_line').notNull(),
    endLine: integer('end_line').notNull(),
    contentHash: text('content_hash'),
    score: real('score'),
    retrievalRank: integer('retrieval_rank'),
    used: boolean('used').notNull().default(false),
  },
  (table) => [unique().on(table.messageId, table.marker)],
);

export type CitationRow = typeof citations.$inferSelect;
export type NewCitationRow = typeof citations.$inferInsert;
