import { Global, Module, ValidationPipe, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import compression from 'compression';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { AppModule } from '../src/app.module';
import { DbModule } from '../src/db/db.module';
import { DB_TOKEN, PG_POOL_TOKEN } from '../src/db/tokens';
import { WorkerService } from '../src/jobs/worker.service';
import { GitPollService } from '../src/jobs/git-poll.service';
import { WatcherService } from '../src/jobs/watcher.service';

import { ProjectsRepository } from '../src/db/repositories/projects.repository';
import { FilesRepository } from '../src/db/repositories/files.repository';
import { ChunksRepository } from '../src/db/repositories/chunks.repository';
import { JobsRepository } from '../src/db/repositories/jobs.repository';
import { ConversationsRepository } from '../src/db/repositories/conversations.repository';
import { ConversationProjectsRepository } from '../src/db/repositories/conversation-projects.repository';
import { MessagesRepository } from '../src/db/repositories/messages.repository';
import { CitationsRepository } from '../src/db/repositories/citations.repository';
import { CredentialsRepository } from '../src/db/repositories/credentials.repository';
import { StorageRepository } from '../src/db/repositories/storage.repository';

/**
 * QA pass — the L2 contract harness.
 *
 * Boots the **real** Nest application graph, so these tests exercise the same
 * routing, the same DTO metadata and — critically — the same global
 * `ValidationPipe` configuration that `main.ts` installs in production. The
 * database and the background workers are the only things replaced.
 *
 * Getting this file wrong would silently invalidate every L2 assertion (a
 * missing `forbidNonWhitelisted` would make a dozen "rejects unknown property"
 * tests pass for the wrong reason), which is why it is built and reviewed once,
 * here, rather than re-derived per spec file.
 *
 * Deliberately NOT using supertest: Node's global `fetch` against a real
 * ephemeral port gives the same coverage with one fewer dependency, and it
 * exercises the actual HTTP stack rather than an in-process shortcut.
 */

/** Anything a fake repository method can be swapped for, per test. */
export type Stub = (...args: never[]) => unknown;

/**
 * Replaces `DbModule`. The real one is `@Global()` and runs migrations in
 * `onModuleInit`, so it cannot simply have its providers overridden — the
 * module class itself must go.
 */
function buildFakeDbModule(repos: Record<string, object>) {
  const providers = [
    { provide: DB_TOKEN, useValue: {} },
    { provide: PG_POOL_TOKEN, useValue: { end: () => Promise.resolve() } },
    { provide: ProjectsRepository, useValue: repos.projects },
    { provide: FilesRepository, useValue: repos.files },
    { provide: ChunksRepository, useValue: repos.chunks },
    { provide: JobsRepository, useValue: repos.jobs },
    { provide: ConversationsRepository, useValue: repos.conversations },
    {
      provide: ConversationProjectsRepository,
      useValue: repos.conversationProjects,
    },
    { provide: MessagesRepository, useValue: repos.messages },
    { provide: CitationsRepository, useValue: repos.citations },
    { provide: CredentialsRepository, useValue: repos.credentials },
    { provide: StorageRepository, useValue: repos.storage },
  ];

  class FakeDbModule {}

  // Decorators applied imperatively because `providers` is built per-harness.
  // @Global() is NOT optional here: the real DbModule is global, so feature
  // modules (CredentialsModule, ChatModule, ...) never import it explicitly —
  // without it, every repository injection fails to resolve.
  Global()(FakeDbModule);
  Module({ providers, exports: providers.map((p) => p.provide) })(FakeDbModule);

  return FakeDbModule;
}

/** The background services are started by Nest's lifecycle; each would hit the DB, the network or fs.watch. */
const INERT_LIFECYCLE = {
  onModuleInit: () => undefined,
  onModuleDestroy: () => undefined,
};

export interface Harness {
  app: INestApplication;
  /** Absolute base URL including the global `api` prefix. */
  url: string;
  /** Issues a request and returns status, parsed body (when JSON) and headers. */
  request: (
    path: string,
    init?: RequestInit,
  ) => Promise<{
    status: number;
    body: unknown;
    text: string;
    headers: Headers;
  }>;
  close: () => Promise<void>;
}

export interface HarnessOptions {
  /** Partial repository fakes, merged over the empty defaults. */
  repos?: Partial<Record<string, object>>;
  /** Partial service overrides, keyed by provider class. */
  overrides?: { provide: unknown; useValue: unknown }[];
}

const EMPTY_REPOS: Record<string, object> = {
  projects: {},
  files: {},
  chunks: {},
  jobs: {},
  conversations: {},
  conversationProjects: {},
  messages: {},
  citations: {},
  credentials: {},
  storage: {},
};

/**
 * Boots the app on an ephemeral port with fakes in place.
 *
 * The pipe configuration below is copied verbatim from `main.ts`. If the two
 * ever diverge, `TC-API-000` fails — it asserts the harness rejects an unknown
 * property, which only holds when `forbidNonWhitelisted` is actually active.
 */
export async function createHarness(
  options: HarnessOptions = {},
): Promise<Harness> {
  const repos = { ...EMPTY_REPOS };
  for (const [key, value] of Object.entries(options.repos ?? {})) {
    repos[key] = { ...(repos[key] ?? {}), ...(value ?? {}) };
  }

  // Nest logs a banner and every route on boot; silence it so a test run stays
  // readable. Restored by `close()`.
  Logger.overrideLogger(false);

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideModule(DbModule)
    .useModule(buildFakeDbModule(repos))
    .overrideProvider(WorkerService)
    .useValue(INERT_LIFECYCLE)
    .overrideProvider(GitPollService)
    .useValue(INERT_LIFECYCLE)
    .overrideProvider(WatcherService)
    .useValue(INERT_LIFECYCLE);

  for (const override of options.overrides ?? []) {
    builder = builder
      .overrideProvider(override.provide)
      .useValue(override.useValue);
  }

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();

  // ---- must mirror main.ts ----
  // Compression is included deliberately, not skipped as "not worth testing":
  // its SSE carve-out is a real invariant (gzip buffers, which would stall
  // token streaming), and without the middleware here the test asserting SSE
  // is uncompressed would pass trivially rather than proving anything.
  app.use(
    compression({
      filter: (req, res) => {
        const contentType = res.getHeader('Content-Type');
        if (
          typeof contentType === 'string' &&
          contentType.includes('text/event-stream')
        ) {
          return false;
        }
        return compression.filter(req, res);
      },
    }),
  );
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // -----------------------------

  await app.init();
  await app.listen(0);

  const server = app.getHttpServer() as Server;
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/api`;

  const request: Harness['request'] = async (path, init) => {
    const response = await fetch(`${url}${path}`, init);
    const text = await response.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return {
      status: response.status,
      body,
      text,
      headers: response.headers,
    };
  };

  return {
    app,
    url,
    request,
    close: async () => {
      await app.close();
      Logger.overrideLogger(true);
    },
  };
}

/** Convenience for a JSON POST/PATCH body. */
export function json(body: unknown, method = 'POST'): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** A syntactically valid UUID that no fixture uses — for 404 paths. */
export const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';
export const VALID_UUID = '11111111-1111-4111-8111-111111111111';
