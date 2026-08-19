<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Retrieval quality

`npm run eval` scores retrieval alone (zero LLM calls) against `evals/questions.json`,
25 hand-written questions with known-correct file paths.

| Mode | recall@5 | recall@10 | MRR |
|---|---|---|---|
| vector | 1.00 | 1.00 | 0.77 |
| fts | 0.84 | 0.88 | 0.58 |
| trigram | 0.12 | 0.12 | 0.10 |
| **hybrid** | 0.92 | 1.00 | 0.77 |

(Numbers above are post-5.4, structural chunking. Pre-5.4 line-window numbers, for
comparison: vector 0.96/1.00/0.77, fts 0.88/0.88/0.63, trigram 0.12/0.12/0.10,
hybrid 0.92/1.00/0.80.)

This baseline is against `fixtures/tiny-repo` only — see `docs/PROGRESS.md`'s Phase 5
notes for why, and for why it scores this well despite the phase doc's warning that
vector-only should score badly on identifier questions.

FTS's per-question misses are exactly the two failure modes it's expected to have and
vector doesn't: the deliberate typo question (`findUsrByEmail`, no fuzzy matching —
that's trigram's job) and the purely structural/meta question about which file
forces the chunker to split. Where it wins is sharper: on several exact-identifier
questions FTS finds the right file at rank 1 while vector buried it further down
(e.g. "Where is the `User` interface defined?" — vector rank 5, FTS rank 1).

**Trigram's low overall number is expected, not a bug — it only fires on questions
containing a camelCase/SCREAMING_SNAKE/dotted-call-shaped token** (`extractIdentifierTokens`),
which most of these 25 questions don't have (`slugify`, `Point`, `Rectangle` are all
single lowercase or single-capitalized words — no case *transition*, so the shape
regex correctly doesn't treat them as identifiers). On the one question built
specifically to need it — the deliberate typo `findUsrByEmail` — trigram hits at
rank 1, exactly the doc's own headline example working.

**Hybrid does not "roughly double" vector-only recall@10 here — it can't, vector-only
is already at the 1.00 ceiling on this fixture** (see the 5.1 note on why). What
*is* real: hybrid's MRR (0.80) beats vector's (0.77), and recall@10 ties at the
ceiling; recall@5 sits fractionally below vector (0.92 vs 0.96) on exactly one
question, "What is the entry point of this program?" — a purely conceptual
question with no identifier for FTS or trigram to anchor on, where even vector
itself only gets a partial win (rank 3, not rank 1).

That one remaining case is genuinely explained, not hand-waved: a chunk that
picks up a rank vote from *two* mediocre-strength arms can still edge out a
chunk with *one* strong vote, when the weaker arms' matches are coincidental
filler-word overlap rather than real relevance (FTS's OR-matching, needed so it
returns anything at all on prose questions, lets that through). This is a known,
accepted property of rank fusion — not something to chase further by hand-tuning
RRF's `k` on one 11-file fixture (measured: sweeping `k` from 60 down to 10 changed
nothing here, because more arm-votes wins regardless of `k`'s exact value). A
genuinely different, non-fixture-specific bug *was* found and fixed here, though:
see the "one canonical chunk id per file" note in `docs/PROGRESS.md` — before that
fix, a single heavily-chunked file could occupy several slots of the fused ranking
at once, which is exactly the kind of accidental chunker-artifact advantage that
should never decide a ranking.

The doc's "roughly double" recall@10 claim describes a messier real repository with
actual boilerplate collapse and config-needle-in-a-haystack chunks (see the 5.1 note
on why that repo was deliberately deferred); expect hybrid's real recall@10 advantage
to show up there, where vector-only isn't already at 1.00.

FTS's and trigram's MRR moved slightly (0.65→0.63, 0.12→0.10) after adding `chunks.id`
as a secondary `ORDER BY` key to all three retrievers — the canonical-chunk-per-file
fix above means an exact-score tie can now decide which physical chunk represents a
file across repeated identical requests, so leaving tie order to Postgres's whim was
no longer acceptable. The exact hit/miss set per question didn't change, only which
tied row won a given rank — expected, and the point of the fix.

### 5.4 — structural chunking

Chunk boundaries now follow function/class/method nodes (via tree-sitter) instead of
blank-line/brace heuristics, and `chunks.symbol` is populated (verified live: real
`symbol` values for both TypeScript and Python files in `fixtures/tiny-repo`, e.g.
`"AuthService"`-style qualified names for class methods, comma-joined names like
`"findUserByEmail, validateUser, comparePassword, registerUser"` where several small
adjacent functions were merged up toward the target chunk size). The doc's own
framing for this slice — "a smaller lift than 5.3, and worth knowing that" — held
exactly: vector ticked up (0.96→1.00 recall@5, one more question now lands in the
top 5), but FTS and hybrid's MRR ticked *down* slightly (0.65→0.58, 0.80→0.77).

That drop is explained, not just observed: structural chunking deliberately produces
*fewer, larger* chunks by merging small adjacent functions (`buildSearchText`'s
identifier-split form included) — a term that used to dominate a small, single-purpose
chunk's `tsv` now shares a bigger chunk with several unrelated functions' identifiers,
diluting `ts_rank_cd`'s density-based score and nudging that chunk's rank down a
position or two. This is a real, structural trade-off (better chunk *boundaries*,
slightly less lexical *focus* per chunk on a fixture this small), not a regression to
chase — the doc predicted exactly this shape of result before a single line was written.

Two things verified directly, beyond the recall table:

- **`CHUNKER_VERSION` invalidation re-chunks without forcing re-embedding.** Set every
  file's `content_hash` to a stale value (the same effect a version bump has) and
  force-reindexed: all 11 files were genuinely re-chunked (new chunk rows, new ids),
  but the on-disk embedding cache file count was identical before and after (275 files,
  zero new entries) — the rebuilt chunk text was byte-identical to what was already
  cached, so the local embedding model was never re-invoked.
- **The context header never leaked into `chunks.content`.** The chunker property
  test (extended to the new `TreeSitterChunker`, `src/chunking/tree-sitter.chunker.spec.ts`)
  still asserts `content === lines.slice(startLine-1, endLine).join('\n')` for every
  chunk of every fixture file, header-free.

### Phase 8 — `halfvec` migration

`chunks.embedding` moved from `vector(768)` (32-bit floats) to `halfvec(768)`
(16-bit floats): `ALTER TABLE chunks ALTER COLUMN embedding SET DATA TYPE halfvec(768)`,
applied live against the dev database with no `USING` clause needed — pgvector
registers an implicit cast, and `drizzle-kit generate` produced exactly that
one-line diff with no hand-editing required. No HNSW index step was part of
this migration; unlike the phase doc's `DROP INDEX chunks_embedding_hnsw` /
`CREATE INDEX ... USING hnsw` snippet assumes, **this repo never actually built
the HNSW index Phase 1 designed** — `grep` across every migration in
`drizzle/*.sql` turns up zero HNSW indexes, only the two GIN indexes for FTS
and trigram. Vector search has always been an exact sequential scan; adding an
ANN index now would be a separate, real decision (approximate vs. exact search
is a different trade-off than float precision) and was deliberately left out
of this slice rather than bundled in silently.

Recall, re-run after the migration on the same `fixtures/tiny-repo` + 25
questions as every number above: **identical to the pre-migration baseline**,
vector 1.00/1.00/0.77, fts 0.84/0.88/0.58, trigram 0.12/0.12/0.10, hybrid
0.92/1.00/0.77 — not "barely moves," didn't move at all on this fixture size.
Storage did: `GET /api/projects/:id/storage` on "Calendar 2" (477 chunks) went
from 196,864 vector bytes to 98,676 — a clean ~50% reduction, exactly the
2-bytes-vs-4-bytes-per-dimension arithmetic predicts. (The same before/after
also showed `sharedIndexBytes` drop, from 409,600 to 221,184 — that's the GIN
indexes shrinking because `ALTER COLUMN TYPE` rewrites the whole table and
rebuilds every index on it, incidentally clearing accumulated bloat; it's not
a halfvec effect and shouldn't be read as one.)

### Phase 8 — answer quality (LLM judge)

`npm run eval:answers` scores *answers*, not retrieval: for each question in
`evals/answer-questions.json` it retrieves (hybrid, same as the real Fast
path), generates a real answer with the active `CHAT_PROVIDER`, then has a
second LLM call grade that answer against the evidence it was given on three
dimensions — `grounded` (no invented claims), `allClaimsCited` (every claim
carries a `[n]`), and `handledUnknownCorrectly` (refuses when the evidence
genuinely doesn't contain the answer, attempts one when it does). The judge
is deliberately the same `chatProvider.complete()` real answers use — there's
no documented reason in this project's plan to hardcode a different judge
model, and every other one-shot LLM call here (condensation, summarization,
the tour) already reuses the injected provider the same way. Two of the six
questions are deliberately unanswerable from this fixture (payment/billing
logic, a Redis connection) specifically to exercise `handledUnknownCorrectly`
in both directions, not just the "found it" case every other eval question
tests.

Per this project's own "treat as a trend, not a gate" framing, this is a
manual `npm run eval:answers`, not a CI check — and the first real run
surfaced exactly the kind of thing it's for. `gemini-flash-latest` (this
repo's default `CHAT_PROVIDER`) was hitting a persistent `503 UNAVAILABLE`
("high demand") from Google at the time of writing — not a bug in the
harness (the very first question, both the answer call and the judge call,
completed and cached correctly before the second question's call started
failing, and three retries a few seconds apart all hit the same error) — so
the number below is from a one-off `CHAT_PROVIDER=groq` override instead,
without touching `.env`:

| Dimension | Rate |
|---|---|
| grounded | 0.83 |
| all claims cited | 0.33 |
| handled unknowns correctly | 1.00 |

`handledUnknownCorrectly` at a clean 1.00 is the headline result — both
deliberately-unanswerable questions got a real "the evidence doesn't show
this" answer instead of a hallucinated one, and every answerable question
got a real attempt. `allClaimsCited` at 0.33 is a genuinely new, real
finding, not noise: Groq's `openai/gpt-oss-120b` (`supportsTools: false`,
per the Phase 7 notes) reliably grounds its claims in the retrieved evidence
but is noticeably looser than Gemini about actually attaching a `[n]` marker
to every one of them — several judged answers were marked "correct and
grounded, but missing a citation marker on the primary claim." This is
exactly the kind of gap Phase 5's retrieval-only harness cannot see at all,
and worth re-running against the default Gemini provider once its outage
clears, to see whether that citation-discipline gap is Groq-specific or
shows up there too.

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
