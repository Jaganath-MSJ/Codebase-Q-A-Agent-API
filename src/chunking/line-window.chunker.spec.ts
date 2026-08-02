import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { LineWindowChunker } from './line-window.chunker';
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

describe('LineWindowChunker property test', () => {
  it('every chunk of every fixture file reconstructs exactly from its line range', async () => {
    const chunker = new LineWindowChunker();
    const relPaths = await listFixtureFiles(FIXTURE_ROOT);
    expect(relPaths.length).toBeGreaterThan(0);

    for (const rel of relPaths) {
      const raw = await readFile(path.join(FIXTURE_ROOT, rel), 'utf8');
      const { lines } = toLines(raw);
      const chunks = chunker.chunk(lines);

      for (const chunk of chunks) {
        const reconstructed = lines.slice(chunk.startLine - 1, chunk.endLine).join('\n');
        expect(reconstructed, `mismatch in ${rel} chunk ${chunk.ord}`).toBe(chunk.content);
      }
    }
  });

  it('returns no chunks for an empty file', () => {
    const chunker = new LineWindowChunker();
    expect(chunker.chunk([])).toEqual([]);
  });

  it('returns a single chunk for a single-line file with no trailing newline', () => {
    const { lines } = toLines('const x = 1;');
    const chunks = new LineWindowChunker().chunk(lines);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ ord: 0, startLine: 1, endLine: 1, content: 'const x = 1;' });
  });

  it('normalizes CRLF input before chunking', () => {
    const { lines } = toLines('line one\r\nline two\r\nline three\r\n');
    expect(lines).toEqual(['line one', 'line two', 'line three']);
    const chunks = new LineWindowChunker().chunk(lines);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe('line one\nline two\nline three');
  });

  it('handles a single very long line as one chunk', () => {
    const longLine = 'x'.repeat(5000);
    const { lines } = toLines(longLine);
    const chunks = new LineWindowChunker().chunk(lines);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe(longLine);
  });

  it('splits a long file into multiple overlapping chunks, each still reconstructing exactly', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const chunks = new LineWindowChunker().chunk(lines);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(lines.slice(chunk.startLine - 1, chunk.endLine).join('\n')).toBe(chunk.content);
    }
    // consecutive chunks overlap or at least touch, never leaving a gap
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startLine).toBeLessThanOrEqual(chunks[i - 1]!.endLine + 1);
    }
    // full coverage: first chunk starts at line 1, last chunk reaches the end
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[chunks.length - 1]!.endLine).toBe(lines.length);
  });
});
