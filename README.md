# Codebase Q&A Agent — API

NestJS + Drizzle + PostgreSQL/pgvector. Indexes codebases and answers questions about
them with citations that point at real lines of real files.

The web client lives in a separate repository (`../web`). This service owns all business
logic: source acquisition, walking, chunking, embedding, hybrid retrieval, and generation.

## Setup

```bash
npm install
cp .env.example .env    # then fill it in
```

`.env.example` documents every variable. Two extensions must exist in the database
before first use:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

Migrations apply themselves — `DbModule.onModuleInit` runs them against `drizzle/` on
every boot, so starting the API is enough.

## Commands

```bash
npm run start:dev        # :3000, OpenAPI docs at /api/docs (watch mode)
npm run start:prod       # node dist/main
npm run build            # nest build
npm run test             # vitest
npm run test:watch       # vitest, watch mode
npm run lint             # eslint --fix
npm run format           # prettier

npm run eval             # retrieval recall harness — no LLM calls
npm run eval:answers     # answer-quality LLM judge — manual, not a CI gate
npm run bench            # retrieval latency benchmark
npm run bench:index      # indexing throughput benchmark
npm run qa:live          # 73 black-box probes against a running server
```

New migration: `npx drizzle-kit generate`, then hand-edit it for the extensions and
indexes drizzle-kit does not emit (see `drizzle/0022_vector_indexes.sql`).

## Retrieval quality

`npm run eval` scores retrieval alone, with zero LLM calls, against
`evals/questions.json` — 25 hand-written questions with known-correct file paths.
Measured on `fixtures/tiny-repo`:

| Mode | recall@5 | recall@10 | MRR |
|---|---|---|---|
| vector | 1.00 | 1.00 | 0.77 |
| fts | 0.84 | 0.88 | 0.58 |
| trigram | 0.12 | 0.12 | 0.10 |
| **hybrid** | 0.92 | 1.00 | 0.77 |

Two of these look wrong and are not. **Trigram's 0.12 is expected**: it only fires on
questions containing a camelCase/SCREAMING_SNAKE/dotted-call-shaped token, which most of
these 25 don't have. On the one question built to need it — the deliberate typo
`findUsrByEmail` — it hits at rank 1. **Hybrid does not beat vector here** because
vector is already at the 1.00 ceiling on a fixture this small; hybrid's advantage shows
up on a messier real repository, not on eleven files.

Latency and indexing-throughput baselines, plus the HNSW index findings, are in
[`evals/BASELINES.md`](evals/BASELINES.md).

## Documentation

Architecture, the full DDL, and the reasoning behind every decision live in `../docs`.
Start with `docs/PLAN.md`; `docs/architecture.md` is the deep reference. Standing
context for working in this repository is in [`CLAUDE.md`](CLAUDE.md).

## Security

The service has **no authentication** and is built to run on localhost. See
[SECURITY.md](SECURITY.md) before exposing it anywhere, and for how untrusted repos,
zips and credentials are handled.

## License

[MIT](LICENSE).
