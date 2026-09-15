import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';

/**
 * QA pass — TC-COV-*.
 *
 * A meta-test: every routable endpoint in the application must be named by at
 * least one L2 spec.
 *
 * This exists because of a real miss. Layer L2 was reported complete while
 * `GET /projects/:projectId/events` — the indexing progress SSE stream — had no
 * test at all. Nothing failed; the suite was green; the endpoint count in the
 * plan ("21 routes") was simply wrong and never re-derived from the source.
 *
 * Counting by hand does not scale and does not survive a new controller being
 * added. This does.
 */

const SRC = path.resolve(__dirname, '..', 'src');
const TEST_DIR = __dirname;

interface Endpoint {
  file: string;
  method: string;
  routePath: string;
  handler: string;
}

/** Extracts the controller prefix and every route decorator from a controller file. */
function parseController(source: string, file: string): Endpoint[] {
  const prefix =
    /@Controller\(\s*['"]([^'"]*)['"]\s*\)/.exec(source)?.[1] ??
    (/@Controller\(\s*\)/.test(source) ? '' : null);
  if (prefix === null) return [];

  const endpoints: Endpoint[] = [];
  const routeRe =
    /@(Get|Post|Put|Patch|Delete|Sse)\(\s*(?:['"]([^'"]*)['"])?\s*\)[\s\S]{0,400}?(?:async\s+)?(\w+)\s*\(/g;

  for (const match of source.matchAll(routeRe)) {
    const [, method, routeSuffix = '', handler] = match;
    const joined = [prefix, routeSuffix].filter(Boolean).join('/');
    endpoints.push({
      file,
      method: method!.toUpperCase(),
      routePath: `/${joined}`,
      handler: handler!,
    });
  }
  return endpoints;
}

describe('L2 route coverage', () => {
  it('TC-COV-001 every controller endpoint is referenced by an L2 spec', async () => {
    const controllerFiles = await fg('**/*.controller.ts', {
      cwd: SRC,
      ignore: ['**/*.spec.ts'],
    });
    expect(controllerFiles.length).toBeGreaterThan(0);

    const endpoints: Endpoint[] = [];
    for (const relPath of controllerFiles) {
      const source = await readFile(path.join(SRC, relPath), 'utf8');
      endpoints.push(...parseController(source, relPath));
    }
    // Guards against the regex silently matching nothing after a refactor.
    expect(endpoints.length).toBeGreaterThanOrEqual(20);

    const specFiles = await fg('**/*.e2e-spec.ts', { cwd: TEST_DIR });
    const specText = (
      await Promise.all(
        specFiles.map((f) => readFile(path.join(TEST_DIR, f), 'utf8')),
      )
    ).join('\n');

    /**
     * An endpoint counts as covered when the specs mention its distinctive
     * path segment. Deliberately loose — this asserts "someone wrote a test
     * naming this route", not "the test is good". Its job is to catch a route
     * with *zero* mentions, which is exactly the failure that occurred.
     */
    const uncovered = endpoints.filter((e) => {
      const segments = e.routePath
        .split('/')
        .filter((s) => s && !s.startsWith(':'));
      if (segments.length === 0) return false; // bare collection route
      // The most specific (last) literal segment is the strongest signal.
      const needle = segments[segments.length - 1]!;
      return !specText.includes(needle);
    });

    expect(
      uncovered.map((e) => `${e.method} ${e.routePath} (${e.file})`),
    ).toEqual([]);
  });

  it('TC-COV-002 both SSE endpoints are covered', async () => {
    // Called out separately because SSE endpoints are the easiest to skip: an
    // infinite stream hangs a naive `await response.text()`, so the temptation
    // is to leave them out. One of the two was in fact missed.
    const controllerFiles = await fg('**/*.controller.ts', { cwd: SRC });
    const sseControllers: string[] = [];
    for (const relPath of controllerFiles) {
      const source = await readFile(path.join(SRC, relPath), 'utf8');
      if (/@Sse\(/.test(source)) sseControllers.push(relPath);
      // The chat stream is a @Post that writes text/event-stream by hand.
      if (/text\/event-stream/.test(source)) sseControllers.push(relPath);
    }
    const unique = [...new Set(sseControllers)];
    expect(unique.sort()).toEqual([
      'chat/chat.controller.ts',
      'jobs/progress.controller.ts',
    ]);

    const specFiles = await fg('**/*.e2e-spec.ts', { cwd: TEST_DIR });
    const specText = (
      await Promise.all(
        specFiles.map((f) => readFile(path.join(TEST_DIR, f), 'utf8')),
      )
    ).join('\n');

    expect(specText).toContain('/events'); // progress stream
    expect(specText).toContain('/messages'); // chat stream
    expect(specText).toMatch(/text\\\/event-stream|text\/event-stream/);
  });
});
