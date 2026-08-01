# Codebase Q&A Agent — API

NestJS + Drizzle + PostgreSQL/pgvector. Indexes codebases and answers questions about them with grounded citations.

Full plan in `docs/`. Read `docs/PLAN.md` before non-trivial work, and the relevant `docs/phases/phase-N-*.md` before starting a slice. Do not re-derive decisions recorded there.

## Non-negotiable invariants

- **Embedding dimension is 768.** Permanently. Assert it at index time, and assert `project.embedding_model` matches the active provider before every retrieval.
- **All paths in the DB and API are repo-relative with forward slashes.** Conversion to native separators happens only in `src/common/paths.ts`.
- **All source file reads go through `src/common/read-file.ts`**, which normalizes CRLF to LF once and returns a `lines` array. Every line number derives from it. Ranges are 1-based and inclusive.
- **The LLM never writes a file path** — only `[n]` markers. Citations are built from server-side data; out-of-range markers are dropped.
- **Local disk is free; Postgres is 0.5 GB.** Repos, model weights, and the embedding and LLM caches live under `data/`, gitignored.
- **`chunking/`, `retrieval/rrf.ts`, `chat/citation.parser.ts` are pure** — no I/O, no DB, no clock.
- **Capability modules never import orchestrators.** `embeddings/` does not import `jobs/`; `indexing/` and `chat/` never import each other.
- **`class-validator` at the HTTP boundary, Zod only for `env.schema.ts`.** Nothing else uses either.

## How to work

Vertical slices: database through UI, one runnable capability at a time. Write tests alongside the pure functions — especially the chunker property test:

```ts
expect(lines.slice(chunk.startLine - 1, chunk.endLine).join('\n')).toBe(chunk.content);
```

## Commands

```bash
npm run dev            # API on :3000, docs at /api/docs
npm run test           # vitest
npm run db:generate    # drizzle-kit generate — then hand-edit for extensions/indexes
npm run db:migrate
npm run eval           # retrieval recall harness (Phase 5)
```

## Environment

Windows, Node 22, no Docker, no Python, no native build tools. `node-gyp` is disqualifying.
