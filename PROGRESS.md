# Progress

> Tick as you go. A slice is done when you can see it working in the browser — not when it compiles.

**Started:** 2026-08-01  **Current slice:** 0 (setup)

---

## Phase 1 — Walking skeleton

- [ ] **0** Setup — two repos, deps, config, type generation, `CLAUDE.md`
- [ ] **1.1 Wired** — add a project by folder path, see it listed
- [ ] **1.2 It sees files** — click Index, see file and chunk counts
  - [ ] chunker property test passes over every fixture chunk
- [ ] **1.3 It has vectors** — type text, get matching chunks back (no LLM)
  - [ ] embedding disk cache in place
- [ ] **1.4 It answers** — ask a question, get a cited answer
  - [ ] LLM disk cache in place
- [ ] **ACCEPTANCE TEST** — all six items

## Phase 2 — Background indexing

- [ ] **2.1 Deferred** — job row, worker claims it, UI polls
- [ ] **2.2 Honest progress** — real counters, read from the database
- [ ] **2.3 Pushed** — SSE with snapshot on connect; refresh mid-index works
- [ ] **2.4 Durable** — kill the API mid-index, restart, it resumes
- [ ] **2.5 Selective** — real filtering, skip breakdown, cancel
- [ ] **ACCEPTANCE TEST** — especially item 4: re-index unchanged, zero embed calls

## Phase 3 — Real conversation

- [ ] **3.1 Remembered** — conversations and messages persist
- [ ] **3.2 Streaming** — tokens arrive one by one
- [ ] **3.3 Sourced** — Sources panel shows cited *and* uncited chunks
- [ ] **3.4 Clickable** — file viewer opens at the cited lines
- [ ] **3.5 Contextual** — follow-up questions with pronouns work
- [ ] **ACCEPTANCE TEST**

## Phase 4 — GitHub and the tour

- [ ] **4.1 Adapted** — `SourceAdapter` extracted, nothing else changes
- [ ] **4.2 Cloned** — paste a GitHub URL, it clones and indexes
- [ ] **4.3 Oriented** — repo overview digest in every prompt
- [ ] **4.4 Toured** — tour card appears when indexing completes
- [ ] **ACCEPTANCE TEST**

## Phase 5 — Hybrid retrieval

- [ ] **5.1 Measured** — baseline recall for vector-only
  - Baseline: recall@5 ____ · recall@10 ____ · MRR ____
- [ ] **5.2 Lexical** — FTS retriever, debug page side by side
- [ ] **5.3 Fused** — RRF, hybrid becomes the default
  - Hybrid: recall@5 ____ · recall@10 ____ · MRR ____
- [ ] **5.4 Structural** — tree-sitter chunking, `symbol` populated
  - Final: recall@5 ____ · recall@10 ____ · MRR ____
- [ ] **ACCEPTANCE TEST** — put the table in the README

## Phase 6 — Zip and private repos

- [ ] **6.1 Uploaded** — zip-slip defence (write the attack first)
- [ ] **6.2 Private** — encrypted credentials, token never on disk
- [ ] **ACCEPTANCE TEST** — especially items 1 and 7

## Phase 7 — Agentic search

- [ ] **7.1 One tool** — `search_code` only, loop terminates, budget capped
- [ ] **7.2 Four tools** — real multi-step investigation
- [ ] **7.3 Cited** — evidence ledger, working `[n]` chips
- [ ] **7.4 Chosen** — mode toggle, router, trace panel, RAG fallback
- [ ] **ACCEPTANCE TEST**

## Phase 8 — Polish

Pick from the menu in `docs/phases/phase-8-polish.md`. Each item is already one slice.

- [ ] _____
- [ ] _____

---

## Notes to self

Anything that surprised you, blocked you, or turned out differently than the plan expected. Two sentences each; this is where the actual learning gets recorded.

-
