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
| vector | 0.96 | 1.00 | 0.77 |
| fts | 0.88 | 0.88 | 0.63 |
| trigram | 0.12 | 0.12 | 0.10 |
| **hybrid** | 0.92 | 1.00 | **0.80** |

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
