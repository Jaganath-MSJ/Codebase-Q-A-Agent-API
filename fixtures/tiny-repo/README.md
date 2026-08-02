# Tiny Repo

A small fixture repository used by the Phase 1 walking-skeleton tests and by
manual verification of the indexing pipeline.

## What's here

- `src/index.ts` — entry point
- `src/auth.service.ts` — a fake authentication service, so retrieval tests
  have something plausible to find when searching for "authentication"
- `src/utils.ts` — a handful of small helper functions
- `src/big-module.ts` — long enough to force the chunker to split it into
  multiple overlapping chunks

The remaining files exist to exercise edge cases in the chunker and the
walker: an empty file, a file with no trailing newline, a file using CRLF
line endings, a file that is one very long line, a file the walker should
skip for being too large, and a couple of paths the walker should skip by
name (`.git/`, `node_modules/`).
