import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  timestamp,
  halfvec,
  unique,
  uniqueIndex,
  index,
  check,
  boolean,
  jsonb,
  customType,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// tsvector has no built-in drizzle column type; it's only ever read via raw
// SQL rank functions, never mapped through JS, so a plain string data type
// is enough to let drizzle emit the right DDL.
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

// pg-core has no built-in `bytea` helper; node-postgres already maps it to a
// plain Node Buffer on both read and write, so this customType just needs to
// name the DDL type — no serialize/deserialize hooks required.
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export interface TourCitation {
  marker: number;
  path: string;
  startLine: number;
  endLine: number;
}

export interface TourSection {
  title: string;
  body: string;
  citations: TourCitation[];
}

export interface TourRecord {
  summary: string;
  sections: TourSection[];
  generatedAt: string;
  // The project.headRevision this tour was generated against — lets a
  // job.completed firing from an unchanged re-index (or a failed re-index of
  // an otherwise-ready project) skip regeneration instead of burning 5-8
  // model calls for a tour that would come out identical.
  revision: string;
}

export interface ChangeAnalysisCitation {
  marker: number;
  path: string;
  startLine: number;
  endLine: number;
}

export interface ChangeAnalysisRecord {
  commitHash: string;
  commitMessage: string;
  changedFiles: string[];
  summary: string;
  citations: ChangeAnalysisCitation[];
  generatedAt: string;
  // The project.headRevision this was generated against — same idempotency
  // shape as TourRecord.revision, keyed to job.completed firing on a new commit.
  revision: string;
}

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    sourceKind: text('source_kind').notNull().default('local_path'),
    sourceRef: text('source_ref').notNull(),
    // Absolute path on disk the adapter last materialized into — the local
    // folder itself for local_path, data/workspaces/<id> for a git clone.
    workspacePath: text('workspace_path'),
    defaultBranch: text('default_branch'),
    // Git sha, or a content-tree hash for non-git sources — compared against
    // the adapter's freshly materialized revision to skip a no-op re-index.
    headRevision: text('head_revision'),
    // ~600-token digest (dir tree, language, detected frameworks, README lead)
    // recomputed on every successful index and injected into every chat prompt.
    overview: text('overview'),
    tour: jsonb('tour').$type<TourRecord>(),
    changeAnalysis: jsonb('change_analysis').$type<ChangeAnalysisRecord>(),
    status: text('status').notNull().default('created'),
    fileCount: integer('file_count').notNull().default(0),
    chunkCount: integer('chunk_count').notNull().default(0),
    embeddingModel: text('embedding_model'),
    embeddingDim: integer('embedding_dim'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'projects_source_kind_check',
      sql`${table.sourceKind} IN ('local_path','git_url','zip_upload','git_private')`,
    ),
  ],
);

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
    // halfvec (16-bit floats): pgvector's negligible-recall-loss halving of
    // storage over the full 32-bit `vector` type — see docs/phases/phase-8-polish.md.
    embedding: halfvec('embedding', { dimensions: 768 }),
    // Qualified name from the structural chunker (e.g. "AuthService.validateUser") —
    // null for chunks the line-window fallback produced, or for gap-fill chunks
    // between structural nodes. See chunking/tree-sitter.chunker.ts.
    symbol: text('symbol'),
    // Chunk content plus its identifier-split form (see retrieval/identifiers.ts) —
    // lets a plain-English query like "user email" match `getUserByEmail`.
    searchText: text('search_text').notNull().default(''),
    tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('simple', search_text)`),
  },
  (table) => [
    unique().on(table.fileId, table.ord),
    index('chunks_tsv_gin').using('gin', table.tsv),
    index('chunks_trgm_gin').using('gin', table.searchText.op('gin_trgm_ops')),
    // Phase 12.1: ANN vector search. Partial (embedded rows only) HNSW index over
    // cosine distance on halfvec(768). Opclass MUST be halfvec_cosine_ops to match
    // the column type and the `<=>`/cosineDistance operator in vector.retriever.ts;
    // the partial predicate mirrors that retriever's `isNotNull(embedding)` filter.
    index('chunks_embedding_hnsw')
      .using('hnsw', table.embedding.op('halfvec_cosine_ops'))
      .with({ m: 16, ef_construction: 64 })
      .where(sql`${table.embedding} IS NOT NULL`),
    // Per-project queries stop scanning every project's chunks (the whole table).
    index('chunks_project_id_idx').on(table.projectId),
  ],
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
    // findLatestByProject / findLatestByProjectIds sort each project's jobs by
    // recency with no status filter, so neither the (status, created_at) index
    // nor the partial one_active_job_per_project index below can serve them —
    // both fell back to a full scan on every SSE poll tick and dashboard load.
    index('indexing_jobs_project_id_created_idx').on(table.projectId, table.createdAt),
    uniqueIndex('one_active_job_per_project')
      .on(table.projectId)
      .where(sql`${table.status} IN ('queued','running','paused')`),
  ],
);

export type IndexingJobRow = typeof indexingJobs.$inferSelect;
export type NewIndexingJobRow = typeof indexingJobs.$inferInsert;

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  // The conversation's original/primary project — for a multi-project
  // conversation this is the first project chosen at creation, so every
  // pre-existing single-project code path (overview injection, Thorough
  // mode's tool calls, Markdown export) keeps working unchanged without
  // knowing multi-project conversations exist at all. See
  // `conversationProjects` below for how "does this span more than one
  // project" is actually represented.
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title'),
  // Rolling summary of every exchange older than the fixed recent window —
  // updated incrementally, so `summarizedThroughMsgId` marks the last
  // assistant message already folded in and never needs re-summarizing.
  summary: text('summary'),
  summarizedThroughMsgId: uuid('summarized_through_msg_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ConversationRow = typeof conversations.$inferSelect;
export type NewConversationRow = typeof conversations.$inferInsert;

// Phase 8: lets a conversation span more than one project. Deliberately a
// join table alongside `conversations.project_id`, not a replacement for it,
// and deliberately populated ONLY for conversations actually created as
// multi-project (2+ rows) — an ordinary single-project conversation has ZERO
// rows here, so its retrieval keeps going through the exact original
// single-project call (including throwing loudly on an embedding-model
// mismatch, which is correct when there's no other project to fall back to).
// Only a conversation with 2+ rows here takes the new fan-out-with-per-
// project-failure-isolation path — the two behaviors are deliberately kept
// distinct rather than unified, so the common case is provably unchanged.
export const conversationProjects = pgTable(
  'conversation_projects',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.conversationId, table.projectId] })],
);

export type ConversationProjectRow = typeof conversationProjects.$inferSelect;
export type NewConversationProjectRow = typeof conversationProjects.$inferInsert;

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
    // The CONDENSED standalone query actually searched — set on every
    // assistant message (even the first turn, where it just echoes the
    // original question), so this row always shows what retrieval saw.
    retrievalQuery: text('retrieval_query'),
    provider: text('provider'),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    latencyMs: integer('latency_ms'),
    // Phase 7: the full agent-loop trajectory — [{tool, args, resultSummary, ms}] — null for RAG answers.
    toolTrace: jsonb('tool_trace'),
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
    // Denormalized, like filePath/startLine/endLine below — set only for a
    // multi-project conversation's citations, so the UI can show which
    // project a result came from. Null for every ordinary single-project
    // conversation's citations (the project is already implied by the
    // conversation itself there, so it would be redundant on every row).
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
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

// Separate table, not a column on `projects` — `SELECT * FROM projects` is
// something that happens constantly (logs, the debug UI, an unrelated
// console.log), and a secret must never be in the row that returns. Keeping
// it here means fetching a credential is something a caller has to choose
// to do. `keyVersion` costs nothing today and is what lets CREDENTIAL_KEY
// ever be rotated without a data migration.
export const sourceCredentials = pgTable(
  'source_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    iv: bytea('iv').notNull(),
    authTag: bytea('auth_tag').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('source_credentials_kind_check', sql`${table.kind} IN ('github_pat')`),
    // One credential per project — "re-entering a token replaces the row
    // rather than adding a second one" (upserted by CredentialsRepository).
    unique().on(table.projectId),
  ],
);

export type SourceCredentialRow = typeof sourceCredentials.$inferSelect;
export type NewSourceCredentialRow = typeof sourceCredentials.$inferInsert;
