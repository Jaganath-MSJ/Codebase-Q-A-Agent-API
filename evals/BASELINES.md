# Phase 12 performance baselines (captured before 12.1)

Numbers to beat/compare after each Phase 12 slice. Re-run the same commands after
a change and diff. Captured 2026-09-08, embedding model `local:nomic-ai/nomic-embed-text-v1.5`,
Postgres on Neon (hosted), single dev machine. Latency is network-bound: the ~350 ms
floor is the Neon round-trip, not query compute — read the EXPLAIN `Execution Time`
for the DB-compute signal.

## 12.0.1 — `npm run bench` (retrieval latency)

25 questions × N=20 per query, top_k=10. `db-only` = retriever only, query embedded once
(isolates the DB cost 12.1 changes); `round-trip` = full `RetrievalService.search` incl. embedding.

### Small repo — "Readme" (1 file, 1 chunk; table held 2384 chunks total)

| Metric              |   n | p50 (ms) | p95 (ms) | min | max | mean |
|---------------------|-----|----------|----------|-----|-----|------|
| vector (round-trip) | 500 |   461.17 |   645.77 | 363.93 | 1113.06 | 486.08 |
| hybrid (round-trip) | 500 |   512.50 |  1205.45 | 386.56 | 1811.30 | 638.68 |
| vector (db-only)    | 500 |   365.13 |   536.64 | 286.11 | 2429.05 | 393.42 |

EXPLAIN vector query: **`Seq Scan on chunks`** (`Rows Removed by Filter: 2383`, matched 1),
**Execution Time 1.04 ms**.

### Large repo — "Codebase-Q-A-Agent (self)" (434 files, 1385 chunks; table ~2388 total)

| Metric              |   n | p50 (ms) | p95 (ms) | min | max | mean |
|---------------------|-----|----------|----------|-----|-----|------|
| vector (round-trip) | 500 |   457.32 |   883.84 | 367.59 | 7727.14 | 536.95 |
| hybrid (round-trip) | 500 |   481.63 |  1118.86 | 371.11 | 3961.75 | 587.36 |
| vector (db-only)    | 500 |   352.79 |   479.87 | 285.62 | 3469.05 | 386.24 |

EXPLAIN vector query: **`Seq Scan on chunks`** (`Rows Removed by Filter: 1003`, matched 1385)
+ **`Seq Scan on files`** (Hash Join), **Execution Time 8.11 ms**.

### What 12.1 must move

- The chunks scan reads the **whole table regardless of project** (no `project_id` index):
  even the 1-chunk "Readme" query removed 2383 rows by filter. `chunks_project_id_idx` fixes this.
- DB compute grew **1.04 ms → 8.11 ms** as matched rows went 1 → 1385 — the "latency grows with
  corpus" the HNSW index removes. It's dwarfed by the ~350 ms Neon RTT, so **watch EXPLAIN
  `Execution Time` and the plan node** (`Index Scan using chunks_embedding_hnsw`), not p50 wall-clock.
- Guardrail: `npm run eval` recall@5/@10/MRR must NOT regress.

## 12.0.2 — `npm run bench:index` (indexing throughput)

Cold force-index (clears the project's files first so everything re-chunks + re-embeds),
per-phase wall-clock from `onProgress`. Baseline on "React-Portfolio (local)" — 59 files, 92 chunks:

| Phase       | wall-clock (ms) |
|-------------|-----------------|
| walking     |           184.0 |
| chunking    |         19657.2 |
| embedding   |         13923.0 |
| finalizing  |            92.7 |
| **TOTAL**   |       **33933.2** |

`fileCount 59 · chunkCount 92 · embedRequests 23 (= ceil(92/4)) · peak RSS 618.7 MB`

## 12.1 — HNSW + project_id index result (measured after applying 0022)

Index built correctly and recall is unaffected, but **the planner does not use the HNSW
index at this corpus size (~2419 chunks total)** — brute-force is genuinely cheaper here.

Recall used the top-k stability substitute (`evals/topk-stability.ts`) rather than
`npm run eval`, because this Postgres has no indexed "Tiny Repo" project row (the
`api/fixtures/tiny-repo` directory exists, but `run-eval.ts` needs it added + indexed).

- **Recall gate (top-k stability, `evals/topk-stability.ts` on "Calendar"):** recall@5 1.000,
  recall@10 1.000, top-1 agree 25/25 — top-k unchanged by the migration. Note this proves the
  migration didn't disturb results, but does NOT exercise HNSW's *approximate* recall: since the
  planner brute-forces at this size (below), both runs are exact seq-scans. True HNSW recall must
  be re-checked once the index is actually chosen (i.e., at scale) — that's when a regression could appear.
- **DB bytes (0.5 GB budget):** total 39 MB → 43 MB. New indexes: `chunks_embedding_hnsw` 4616 kB,
  `chunks_project_id_idx` 32 kB. 8.4% of 512 MB — fine.
- **EXPLAIN, real retrieval query (self, 1385 chunks):** still `Seq Scan on chunks`,
  Execution Time ~8 ms (unchanged from baseline) — planner brute-forces.
- **Forced (`enable_seqscan=off, enable_bitmapscan=off`), global ANN:** DOES use
  **`Index Scan using chunks_embedding_hnsw`** — proving the index is functional — but at
  **118.9 ms vs 7.5 ms** for the seq-scan. HNSW is ~16× slower here; its fixed traversal
  overhead only pays off once a seq-scan of the embedded rows would exceed ~120 ms
  (roughly tens of thousands of rows). pgvector is 0.8.1 (iterative_scan available if/when
  the filtered HNSW path is ever chosen — moot until then).

**Conclusion:** the index is correct, recall-safe, cheap on disk, and is forward-looking
infrastructure that engages automatically once repos are large enough. The doc's
"EXPLAIN shows Index Scan" / "p50 drops" acceptance is a scale property, not met at this
corpus — and that's correct planner behavior, not a defect. Re-run `evals/topk-stability.ts`
and this EXPLAIN probe after indexing a genuinely large repo to see the crossover.

### What Phase 2 must move

- **chunking ~20 s** for 59 files is dominated by per-file `replaceFile` round-trips to Neon
  (+ the double file read) → 12.6 (single read), 12.7 (parallel walk).
- **embedding ~14 s** for 92 chunks = 23 batches, each paying an N+1 per-chunk `setEmbedding`
  write (12.5) plus a `sumEmbedRequestsToday()` daily-sum query even for the local provider (12.9).
- `embedRequests` should drop toward `ceil(chunkCount/batch)` writes (already there) but the
  **row-write count** should collapse from ~chunkCount to ~batches after 12.5.
