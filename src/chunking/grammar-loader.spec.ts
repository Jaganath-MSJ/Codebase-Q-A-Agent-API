import { describe, it, expect } from 'vitest';
import { createTreeSitterChunker } from './grammar-loader';
import { toLines } from '../common/read-file';

/**
 * QA pass — TC-GRAM-*.
 *
 * The only I/O in the chunking capability. It loads four WASM grammars from
 * `@vscode/tree-sitter-wasm` via `require.resolve`, which is exactly the kind
 * of thing that works locally and breaks after a dependency bump or a bundling
 * change — with the failure surfacing as "every file silently falls back to
 * line-window chunking", not as a crash.
 *
 * This runs the real loader against the real package deliberately: mocking it
 * would test nothing that can actually break.
 */
describe('createTreeSitterChunker', () => {
  it('TC-GRAM-001 loads all four grammars without throwing', async () => {
    await expect(createTreeSitterChunker()).resolves.toBeDefined();
  });

  it('TC-GRAM-002 produces a chunker that parses TypeScript structurally', async () => {
    const chunker = await createTreeSitterChunker();
    const source = [
      'export function alpha() {',
      '  return 1;',
      '}',
      '',
      'export function beta() {',
      '  return 2;',
      '}',
    ].join('\n');

    const chunks = chunker.chunk(toLines(source).lines, 'ts');

    // Assert on `symbol`, not on chunk count. The chunker deliberately MERGES
    // adjacent regions under MIN_CHUNK_LINES (30) when the result still fits
    // TARGET_LINES (60), so two 3-line functions correctly become one chunk.
    // Only structural parsing attaches a symbol at all — the line-window
    // fallback leaves it null — so a symbol is the real evidence the WASM
    // grammar loaded.
    expect(chunks.some((c) => c.symbol)).toBe(true);
    const symbols = chunks.map((c) => c.symbol).join(' ');
    expect(symbols).toContain('alpha');
  });

  it('TC-GRAM-002b splits functions that individually exceed the target size', async () => {
    const chunker = await createTreeSitterChunker();
    const body = (name: string) =>
      [
        `export function ${name}() {`,
        ...Array.from({ length: 70 }, (_, i) => `  const v${i} = ${i};`),
        '  return 1;',
        '}',
      ].join('\n');
    const source = `${body('alpha')}\n\n${body('beta')}`;

    const chunks = chunker.chunk(toLines(source).lines, 'ts');

    // Each function is well over TARGET_LINES, so merging cannot apply.
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('TC-GRAM-003 satisfies the INV-9 chunker property on real grammar output', async () => {
    const chunker = await createTreeSitterChunker();
    const source = [
      'class Service {',
      '  method() {',
      '    return 42;',
      '  }',
      '}',
    ].join('\n');
    const { lines } = toLines(source);

    for (const chunk of chunker.chunk(lines, 'ts')) {
      expect(lines.slice(chunk.startLine - 1, chunk.endLine).join('\n')).toBe(
        chunk.content,
      );
    }
  });

  it('TC-GRAM-004 handles each supported language without error', async () => {
    const chunker = await createTreeSitterChunker();
    const samples: [string, string][] = [
      ['ts', 'export const a = 1;'],
      ['tsx', 'export const A = () => <div />;'],
      ['js', 'module.exports = function a() { return 1; };'],
      ['py', 'def alpha():\n    return 1'],
    ];

    for (const [lang, source] of samples) {
      const { lines } = toLines(source);
      expect(() => chunker.chunk(lines, lang), lang).not.toThrow();
    }
  });

  it('TC-GRAM-005 falls back cleanly for a language with no grammar', async () => {
    const chunker = await createTreeSitterChunker();
    const { lines } = toLines('SELECT 1;\nSELECT 2;');
    const chunks = chunker.chunk(lines, 'sql');

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(lines.slice(chunk.startLine - 1, chunk.endLine).join('\n')).toBe(
        chunk.content,
      );
    }
  });
});
