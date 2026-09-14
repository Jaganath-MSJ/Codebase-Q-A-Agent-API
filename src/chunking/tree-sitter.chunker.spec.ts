import { beforeAll, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { createTreeSitterChunker } from './grammar-loader';
import type { TreeSitterChunker } from './tree-sitter.chunker';
import { toLines } from '../common/read-file';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures/tiny-repo');
const SKIP_DIR_PREFIXES = ['.git', 'node_modules'];

async function listFixtureFiles(dir: string, relBase = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIR_PREFIXES.includes(entry.name)) continue;
      files.push(...(await listFixtureFiles(path.join(dir, entry.name), rel)));
    } else {
      files.push(rel);
    }
  }

  return files;
}

function langOf(relPath: string): string {
  return path.extname(relPath).slice(1).toLowerCase();
}

describe('TreeSitterChunker', () => {
  let chunker: TreeSitterChunker;

  beforeAll(async () => {
    chunker = await createTreeSitterChunker();
  }, 30_000);

  describe('property test', () => {
    it('every chunk of every fixture file reconstructs exactly from its line range', async () => {
      const relPaths = await listFixtureFiles(FIXTURE_ROOT);
      expect(relPaths.length).toBeGreaterThan(0);

      for (const rel of relPaths) {
        const raw = await readFile(path.join(FIXTURE_ROOT, rel), 'utf8');
        const { lines } = toLines(raw);
        const chunks = chunker.chunk(lines, langOf(rel));

        for (const chunk of chunks) {
          const reconstructed = lines
            .slice(chunk.startLine - 1, chunk.endLine)
            .join('\n');
          expect(reconstructed, `mismatch in ${rel} chunk ${chunk.ord}`).toBe(
            chunk.content,
          );
        }
      }
    });

    it('returns no chunks for an empty file', () => {
      expect(chunker.chunk([], 'ts')).toEqual([]);
    });

    it('falls back to line-window chunking for a language with no grammar', () => {
      const lines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`);
      const chunks = chunker.chunk(lines, 'md');
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.content).toBe(lines.join('\n'));
    });

    it('falls back to line-window chunking when no lang is given', () => {
      const lines = ['const x = 1;'];
      expect(chunker.chunk(lines)).toEqual(chunker.chunk(lines, undefined));
    });
  });

  describe('symbol population', () => {
    it('populates symbol for TypeScript top-level functions', async () => {
      const raw = await readFile(
        path.join(FIXTURE_ROOT, 'src/auth.service.ts'),
        'utf8',
      );
      const { lines } = toLines(raw);
      const chunks = chunker.chunk(lines, 'ts');

      expect(chunks.some((c) => c.symbol?.includes('findUserByEmail'))).toBe(
        true,
      );
      expect(chunks.some((c) => c.symbol?.includes('validateUser'))).toBe(true);
    });

    it('populates symbol for a TypeScript class', async () => {
      const raw = await readFile(
        path.join(FIXTURE_ROOT, 'src/big-module.ts'),
        'utf8',
      );
      const { lines } = toLines(raw);
      const chunks = chunker.chunk(lines, 'ts');

      expect(chunks.some((c) => c.symbol?.includes('Rectangle'))).toBe(true);
    });

    it('populates symbol for Python class and function definitions', async () => {
      const raw = await readFile(
        path.join(FIXTURE_ROOT, 'src/shapes.py'),
        'utf8',
      );
      const { lines } = toLines(raw);
      const chunks = chunker.chunk(lines, 'py');

      expect(chunks.some((c) => c.symbol?.includes('Rectangle'))).toBe(true);
      expect(chunks.some((c) => c.symbol?.includes('is_square'))).toBe(true);
    });

    it('leaves symbol undefined for pure gap content (imports, no declarations)', () => {
      const lines = ['import { x } from "y";', 'import { z } from "w";'];
      const chunks = chunker.chunk(lines, 'ts');
      expect(chunks.every((c) => c.symbol === undefined)).toBe(true);
    });
  });

  describe('structural splitting', () => {
    it('splits an oversized class into one chunk per method, each qualified by the class name', () => {
      const methodBody = Array.from(
        { length: 20 },
        (_, i) => `    // line ${i}`,
      ).join('\n');
      const src = [
        'export class Big {',
        `  one() {\n${methodBody}\n  }`,
        `  two() {\n${methodBody}\n  }`,
        `  three() {\n${methodBody}\n  }`,
        '}',
      ].join('\n');
      const lines = src.split('\n');

      const chunks = chunker.chunk(lines, 'ts');
      const symbols = chunks.map((c) => c.symbol).filter(Boolean);

      expect(symbols).toContain('Big.one');
      expect(symbols).toContain('Big.two');
      expect(symbols).toContain('Big.three');
      // every chunk still individually reconstructs, the same property the fixture test checks
      for (const chunk of chunks) {
        expect(lines.slice(chunk.startLine - 1, chunk.endLine).join('\n')).toBe(
          chunk.content,
        );
      }
    });

    it('splits an oversized top-level function via the line-window fallback, keeping its symbol', () => {
      const body = Array.from(
        { length: 100 },
        (_, i) => `  console.log(${i});`,
      ).join('\n');
      const src = `function huge() {\n${body}\n}`;
      const lines = src.split('\n');

      const chunks = chunker.chunk(lines, 'ts');

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((c) => c.symbol === 'huge')).toBe(true);
      for (const chunk of chunks) {
        expect(lines.slice(chunk.startLine - 1, chunk.endLine).join('\n')).toBe(
          chunk.content,
        );
      }
    });
  });
});
