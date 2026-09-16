import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';

/**
 * QA pass — TC-INV-*.
 *
 * Architectural invariants from CLAUDE.md, asserted by reading source text.
 * These are cheap, they never go stale the way a comment does, and they fail
 * loudly the moment a refactor crosses a boundary the design depends on.
 *
 * They intentionally test *structure*, not behaviour: a violation here is not
 * a failing feature, it is a design rule that has been broken silently.
 */

const SRC = path.resolve(__dirname, '..', 'src');

async function sourceFiles(
  glob = '**/*.ts',
  extraIgnore: string[] = [],
): Promise<string[]> {
  return fg(glob, {
    cwd: SRC,
    ignore: ['**/*.spec.ts', '**/*.d.ts', ...extraIgnore],
    onlyFiles: true,
  });
}

async function read(relPath: string): Promise<string> {
  return readFile(path.join(SRC, relPath), 'utf8');
}

/** Module specifiers of every static/dynamic import and require in a file. */
function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g, // import … from 'x'  /  export … from 'x'
    /\bimport\s+['"]([^'"]+)['"]/g, // bare side-effect import 'x'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('x')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('x')
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  }
  return specifiers;
}

/** Resolves a relative specifier against the importing file, as a src-relative posix path. */
function resolveLocal(fromRelPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const abs = path.resolve(
    path.dirname(path.join(SRC, fromRelPath)),
    specifier,
  );
  return path.relative(SRC, abs).split(path.sep).join('/');
}

describe('INV-3 — all source file reads go through common/read-file.ts', () => {
  /**
   * Reading a source file anywhere else would produce line numbers that do not
   * derive from `toLines`, silently desynchronising citations from the viewer.
   *
   * These call sites are allowed because none of them reads *source text for
   * line-numbering*. Each carries the reason it is exempt — a new entry here
   * should have to justify itself.
   */
  const ALLOWED = new Map<string, string>([
    ['common/read-file.ts', 'the canonical reader itself'],
    ['llm/cache.ts', 'reads cached LLM responses, not source files'],
    ['embeddings/cache.ts', 'reads cached embedding vectors (binary)'],
    ['walker/gitignore.ts', 'reads .gitignore/.cqaignore rules, not source'],
    [
      'sources/content-tree-hash.ts',
      'reads raw bytes for hashing; never line-splits',
    ],
    [
      'walker/walker.service.ts',
      'reads raw bytes for binary detection, then hands them to toLines',
    ],
    [
      'sources/git-askpass.ts',
      // Added with the DEF-009 fix. Not merely exempt — routing this through
      // read-file.ts would be WRONG: it normalises CRLF to LF, and the helper
      // is a Windows `.cmd` whose CRLF ending is load-bearing, so the
      // byte-exact comparison this read exists for would never match again.
      'reads back its own generated .cmd helper to verify it, byte-exactly; toLines would normalise the CRLF it must preserve',
    ],
  ]);

  it('TC-INV-001 no module outside the allow-list reads files directly', async () => {
    const files = await sourceFiles();
    const offenders: string[] = [];

    for (const relPath of files) {
      if (ALLOWED.has(relPath)) continue;
      const source = await read(relPath);
      if (/\breadFileSync\s*\(|\breadFile\s*\(/.test(source)) {
        offenders.push(relPath);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('TC-INV-002 every allow-list entry still exists and still reads files', async () => {
    // Keeps the exemption list honest: a stale entry would quietly widen the rule.
    const files = new Set(await sourceFiles());
    for (const [relPath] of ALLOWED) {
      expect(files.has(relPath), `${relPath} is allow-listed but missing`).toBe(
        true,
      );
      const source = await read(relPath);
      expect(
        /\breadFileSync\s*\(|\breadFile\s*\(/.test(source),
        `${relPath} is allow-listed but no longer reads files — drop the exemption`,
      ).toBe(true);
    }
  });
});

describe('INV-5 — chunking/, rrf.ts and citation-parser.ts are pure', () => {
  /**
   * These are shared by both orchestrators (`chat/` and `tour/`) precisely
   * because they are pure. I/O, a database handle, or a clock reading inside
   * them would make the two orchestrators share hidden state.
   *
   * `*.module.ts` is excluded deliberately: a Nest module file is DI wiring,
   * not logic, and `@Module` cannot be declared without importing
   * `@nestjs/common`. The invariant is about the chunking *code* being callable
   * without a container — which is exactly what keeps `chat/` and `tour/` able
   * to share it. An `@Injectable()` creeping into a chunker itself is still
   * caught, because only the module file is exempt.
   */
  const PURE_GLOBS = [
    'chunking/**/*.ts',
    'retrieval/rrf.ts',
    'common/citation-parser.ts',
  ];
  const PURE_IGNORE = ['**/*.module.ts'];

  const FORBIDDEN_IMPORTS = [
    'node:fs',
    'node:fs/promises',
    'fs',
    'fs/promises',
    'node:child_process',
    'child_process',
    'node:http',
    'node:https',
    'pg',
    'drizzle-orm',
    '@nestjs/common',
  ];

  it('TC-INV-010 import no I/O, database or framework module', async () => {
    const files = await sourceFiles(`{${PURE_GLOBS.join(',')}}`, PURE_IGNORE);
    expect(files.length).toBeGreaterThan(0); // guard against a vacuous pass

    const violations: string[] = [];
    for (const relPath of files) {
      for (const specifier of importsOf(await read(relPath))) {
        const bare = specifier.split('/').slice(0, 2).join('/');
        if (
          FORBIDDEN_IMPORTS.includes(specifier) ||
          FORBIDDEN_IMPORTS.includes(bare)
        ) {
          violations.push(`${relPath} imports ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('TC-INV-011 read no clock', async () => {
    const files = await sourceFiles(`{${PURE_GLOBS.join(',')}}`, PURE_IGNORE);
    const violations: string[] = [];
    for (const relPath of files) {
      const source = await read(relPath);
      if (
        /\bDate\.now\s*\(|\bnew\s+Date\s*\(|\bperformance\.now\s*\(/.test(
          source,
        )
      ) {
        violations.push(relPath);
      }
    }
    expect(violations).toEqual([]);
  });

  it('TC-INV-012 read no randomness', async () => {
    // Not in the stated invariant, but purity without determinism is not much
    // use: a random tiebreak in RRF would make retrieval irreproducible.
    const files = await sourceFiles(`{${PURE_GLOBS.join(',')}}`, PURE_IGNORE);
    const violations: string[] = [];
    for (const relPath of files) {
      if (/\bMath\.random\s*\(|\brandomUUID\s*\(/.test(await read(relPath))) {
        violations.push(relPath);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('INV-6 — capability modules never import orchestrators', () => {
  /**
   * The direction of dependency is the design: capabilities are reusable
   * because they know nothing about who drives them. `indexing/` and `chat/`
   * are siblings and must stay mutually ignorant.
   */
  const RULES: ReadonlyArray<{ from: string; forbidden: string[] }> = [
    { from: 'embeddings', forbidden: ['jobs', 'indexing', 'chat', 'tour'] },
    { from: 'chunking', forbidden: ['jobs', 'indexing', 'chat', 'tour'] },
    { from: 'retrieval', forbidden: ['jobs', 'indexing', 'chat', 'tour'] },
    { from: 'walker', forbidden: ['jobs', 'indexing', 'chat', 'tour'] },
    { from: 'indexing', forbidden: ['chat', 'tour'] },
    { from: 'chat', forbidden: ['indexing'] },
  ];

  for (const { from, forbidden } of RULES) {
    it(`TC-INV-020 ${from}/ does not import ${forbidden.join(', ')}`, async () => {
      const files = await sourceFiles(`${from}/**/*.ts`);
      expect(files.length).toBeGreaterThan(0);

      const violations: string[] = [];
      for (const relPath of files) {
        for (const specifier of importsOf(await read(relPath))) {
          const local = resolveLocal(relPath, specifier);
          if (!local) continue;
          const topLevel = local.split('/')[0]!;
          if (forbidden.includes(topLevel)) {
            violations.push(`${relPath} imports ${specifier} (${topLevel}/)`);
          }
        }
      }
      expect(violations).toEqual([]);
    });
  }
});
