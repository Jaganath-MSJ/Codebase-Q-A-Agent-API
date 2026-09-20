# Security

## The most important thing to know

**This service has no authentication or authorization.** There are no guards, no
sessions, no API keys on its own endpoints. Anyone who can reach it can list and delete
projects, read the contents of any indexed file, start indexing jobs, and spend your LLM
and embedding quota.

It is built to run on `localhost`, reached through the Vite dev server's proxy. Do not
bind it to a public interface or put it behind a tunnel without adding an
authentication layer first. `PORT` and the absence of CORS configuration are not a
security boundary — CORS restricts browsers, not `curl`.

## What it does with untrusted input

The whole point of the service is to ingest code it did not write, so three inputs are
untrusted by design:

| Input | Handled by |
|---|---|
| A public git URL | `sources/git-url.adapter.ts` — cloned to `data/`, never executed |
| A private repo + token | `sources/git-private.adapter.ts` + `sources/git-askpass.ts` |
| An uploaded `.zip` | `sources/zip-extractor.ts` + `sources/zip-path-guard.ts` |

**Cloned and extracted code is only ever read, never run.** Nothing invokes a build, a
package manager, or a script from an indexed repository.

### Zip slip

Two independent layers, deliberately:

1. `assertSafeZipEntryPath` — pure and shape-based. Rejects absolute entries, Windows
   drive letters, and any `..` segment, before a path is resolved at all.
2. `resolveInside` (`common/paths.ts`) — the load-bearing one. Checks the candidate
   against both POSIX and Win32 path grammars, then does a final host-native containment
   check against the resolved root.

The first exists to fail early with a precise per-entry error; the second is what
actually guarantees containment. Both are covered by `zip-path-guard.spec.ts` and the
`paths` property tests.

### Path traversal on reads

Every file read from a workspace goes through `resolveInside`. `GET /projects/:id/file`
additionally serves **only paths that have a `files` row** — being inside the project
root is not sufficient.

That second condition was added in response to a real defect: **DEF-015**, where the
route served any file under the project root whether indexed or not. On a project rooted
at this repository, that made `api/.env` readable over HTTP. If you ever ran a build
from before that fix, **rotate your provider keys and database password.** The defect and
its fix are recorded in `docs/qa/DEFECTS.md`.

## Secrets

| Secret | Where it lives |
|---|---|
| `GOOGLE_API_KEY`, `GROQ_API_KEY` | `.env`, server-side only |
| `DATABASE_URL` | `.env` |
| `CREDENTIAL_KEY` | `.env` — encrypts stored git tokens |
| Stored git tokens | the database, encrypted |

Git tokens for private repositories are encrypted with **AES-256-GCM**, a fresh 96-bit
random IV per encryption, under a 256-bit key decoded from `CREDENTIAL_KEY`
(`credentials/crypto.util.ts`). Losing `CREDENTIAL_KEY` means every stored token must be
re-entered; changing it does not re-encrypt existing rows.

During a clone, the token is supplied to git through an **askpass script**
(`sources/git-askpass.ts`) rather than the command line or the remote URL, so it does not
appear in the process table or in git's own error output. The script holds only the *name*
of the environment variable the token travels through, never the token, and the file is
content-compared on every call rather than merely checked for existence (DEF-009).

The helper is written in the host's own terms — a `.cmd` batch file on Windows, an
executable `/bin/sh` script (mode 0700) elsewhere — and on POSIX the mode is part of what
the content check considers correct, so a helper that is present but not runnable is
repaired rather than handed to git. `printf` rather than `echo` means a token beginning
with `-` is emitted literally instead of being read as a flag. See DEF-036.

`GET /providers` deliberately reports provider health without ever returning a key; the
live probe suite asserts this (`LP-404`).

Tool error notes are redacted before they reach the model (`common/redact.ts`) — a
previous defect leaked the absolute workspace path into LLM context.

### Two operational notes

- **`.env` is blocked from automated edits** by a repository hook. Anything in this
  project that needs a credential changed is an operator step, by design.
- **A secrets file inside an indexed repository will be indexed.** The walker filters by
  gitignore, binary content and size — nothing reads filenames for intent, so a
  non-ignored `Keys.txt` at a repo root becomes searchable chunk text and can be quoted
  in an answer. This is recorded as DEF-030 and resolved as an operator-data decision,
  not a code defect. Do not point the indexer at a repository holding live credentials.

## Reporting a vulnerability

Open a GitHub issue for anything already public, such as a hardened check that can be
improved. For anything exploitable, please report it privately through GitHub's
**Report a vulnerability** flow on this repository rather than opening a public issue.

Please include the version or commit, what you observed, and the smallest reproduction
you have. There is no bounty; this is a personal project.

## Scope

In scope: path traversal and zip slip, credential handling and leakage, anything that
turns indexed content into executed code, and injection through model output into a
citation or a link.

Out of scope: the absence of authentication (documented above and intended), denial of
service through large repositories or quota exhaustion, and anything requiring an
attacker who already has local filesystem or `.env` access.
