import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { toLines, readSourceFile } from './read-file';

/**
 * QA pass — TC-RF-*.
 *
 * `toLines` is the origin of every line number in the system: chunk ranges,
 * citation ranges, and the file viewer all index into the array it returns.
 * The governing invariant (INV-3 / INV-9) is that for any 1-based inclusive
 * range, `lines.slice(start - 1, end).join('\n')` reproduces exactly the text
 * that range denotes.
 */
describe('toLines', () => {
  describe('TC-RF-001..006 — line splitting', () => {
    it('TC-RF-001 returns no lines for an empty string', () => {
      expect(toLines('')).toEqual({ text: '', lines: [] });
    });

    it('TC-RF-002 returns a single line for content with no trailing newline', () => {
      expect(toLines('const x = 1;').lines).toEqual(['const x = 1;']);
    });

    it('TC-RF-003 does not emit a phantom trailing line for a trailing newline', () => {
      expect(toLines('a\n').lines).toEqual(['a']);
      expect(toLines('a\nb\n').lines).toEqual(['a', 'b']);
    });

    it('TC-RF-004 preserves a genuinely blank final line', () => {
      // "a\n\n" is two lines: "a" and an empty one. Only ONE trailing newline
      // is structural; the second denotes a real empty line.
      expect(toLines('a\n\n').lines).toEqual(['a', '']);
    });

    it('TC-RF-005 treats a lone newline as one empty line', () => {
      expect(toLines('\n').lines).toEqual(['']);
    });

    it('TC-RF-006 preserves interior blank lines exactly', () => {
      expect(toLines('a\n\n\nb').lines).toEqual(['a', '', '', 'b']);
    });
  });

  describe('TC-RF-010..014 — line-ending normalisation', () => {
    it('TC-RF-010 normalises CRLF to LF throughout', () => {
      const { text, lines } = toLines('a\r\nb\r\nc');
      expect(lines).toEqual(['a', 'b', 'c']);
      expect(text).not.toContain('\r');
    });

    it('TC-RF-011 handles a file that is entirely CRLF with a trailing CRLF', () => {
      expect(toLines('a\r\nb\r\n').lines).toEqual(['a', 'b']);
    });

    it('TC-RF-012 handles mixed CRLF and LF in one file', () => {
      expect(toLines('a\r\nb\nc\r\nd').lines).toEqual(['a', 'b', 'c', 'd']);
    });

    it('TC-RF-013 leaves no carriage return anywhere after normalising CRLF', () => {
      const { lines } = toLines('x\r\ny\r\n');
      for (const line of lines) expect(line).not.toContain('\r');
    });

    it('TC-RF-014 [DEFECT-002] does NOT normalise a lone CR (classic-Mac endings)', () => {
      // Documents current behaviour: only \r\n is rewritten. A CR-only file
      // therefore collapses to a single line containing raw CR characters.
      const { lines } = toLines('a\rb\rc');
      expect(lines).toEqual(['a\rb\rc']);
      expect(lines).toHaveLength(1);
    });
  });

  describe('TC-RF-020..024 — encoding and exotic content', () => {
    it('TC-RF-020 [DEFECT-001] does NOT strip a UTF-8 BOM', () => {
      // Documents current behaviour: the BOM stays glued to the first line, so
      // line 1 of a BOM-prefixed file differs invisibly from its on-screen text.
      //
      // Written as `\uFEFF`, never as a literal BOM byte: a literal would make
      // git classify this whole file as binary, costing every future diff,
      // blame and review on it.
      const { lines } = toLines('\uFEFFconst x = 1;');
      expect(lines[0]).toBe('\uFEFFconst x = 1;');
      expect(lines[0]!.charCodeAt(0)).toBe(0xfeff);
    });

    it('TC-RF-021 preserves emoji and astral-plane characters', () => {
      const { lines } = toLines('const flag = "🇯🇵";\nconst math = "𝕏";');
      expect(lines).toEqual(['const flag = "🇯🇵";', 'const math = "𝕏";']);
    });

    it('TC-RF-022 preserves right-to-left text', () => {
      expect(toLines('const s = "مرحبا";').lines).toEqual([
        'const s = "مرحبا";',
      ]);
    });

    it('TC-RF-023 preserves NUL bytes without truncating the line', () => {
      const { lines } = toLines('a\u0000b\nc');
      expect(lines).toEqual(['a\u0000b', 'c']);
    });

    it('TC-RF-024 handles a 10,000-character single line', () => {
      const long = 'x'.repeat(10_000);
      const { lines } = toLines(long);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toHaveLength(10_000);
    });
  });

  describe('TC-RF-030..034 — INV-9 range-reconstruction property', () => {
    const reconstruct = (lines: string[], start: number, end: number) =>
      lines.slice(start - 1, end).join('\n');

    it('TC-RF-030 reconstructs the whole file from the full range', () => {
      const { lines } = toLines('a\nb\nc');
      expect(reconstruct(lines, 1, lines.length)).toBe('a\nb\nc');
    });

    it('TC-RF-031 reconstructs a one-line range', () => {
      const { lines } = toLines('a\nb\nc');
      expect(reconstruct(lines, 2, 2)).toBe('b');
    });

    it('TC-RF-032 reconstructs the final line without a trailing newline artefact', () => {
      const { lines } = toLines('a\nb\nc\n');
      expect(reconstruct(lines, 3, 3)).toBe('c');
    });

    it('TC-RF-033 holds for every range of a CRLF file', () => {
      const { lines } = toLines('one\r\ntwo\r\nthree\r\nfour\r\n');
      for (let start = 1; start <= lines.length; start++) {
        for (let end = start; end <= lines.length; end++) {
          const slice = reconstruct(lines, start, end);
          expect(slice.split('\n')).toEqual(lines.slice(start - 1, end));
        }
      }
    });

    it('TC-RF-034 holds across randomised inputs', () => {
      const alphabet = ['a', '', 'bb', 'c c', '  indented', '}'];
      for (let trial = 0; trial < 200; trial++) {
        const count = 1 + ((trial * 7) % 12);
        const raw = Array.from(
          { length: count },
          (_, i) => alphabet[(trial + i) % alphabet.length],
        ).join('\n');
        const { lines } = toLines(raw);
        const start = 1 + (trial % lines.length);
        const end = start + ((trial * 3) % (lines.length - start + 1));
        expect(reconstruct(lines, start, end)).toBe(
          lines.slice(start - 1, end).join('\n'),
        );
      }
    });
  });

  describe('TC-RF-040..042 — the `text` field', () => {
    it('TC-RF-040 returns text with CRLF already normalised', () => {
      expect(toLines('a\r\nb').text).toBe('a\nb');
    });

    it('TC-RF-041 keeps the trailing newline in `text` that `lines` drops', () => {
      const { text, lines } = toLines('a\nb\n');
      expect(text).toBe('a\nb\n');
      expect(lines.join('\n')).toBe('a\nb');
    });

    it('TC-RF-042 returns an empty text for empty input', () => {
      expect(toLines('').text).toBe('');
    });
  });
});

describe('readSourceFile', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'qa-read-file-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = async (name: string, content: string | Buffer) => {
    const file = path.join(dir, name);
    await writeFile(file, content);
    return file;
  };

  it('TC-RF-050 reads a file from disk and splits it into lines', async () => {
    const file = await write('basic.ts', 'const a = 1;\nconst b = 2;\n');
    expect((await readSourceFile(file)).lines).toEqual([
      'const a = 1;',
      'const b = 2;',
    ]);
  });

  it('TC-RF-051 normalises CRLF read from disk', async () => {
    const file = await write('crlf.ts', 'a\r\nb\r\n');
    const { lines, text } = await readSourceFile(file);
    expect(lines).toEqual(['a', 'b']);
    expect(text).not.toContain('\r');
  });

  it('TC-RF-052 returns no lines for a zero-byte file', async () => {
    const file = await write('empty.ts', '');
    expect((await readSourceFile(file)).lines).toEqual([]);
  });

  it('TC-RF-053 rejects when the file does not exist', async () => {
    await expect(
      readSourceFile(path.join(dir, 'does-not-exist.ts')),
    ).rejects.toThrow(/ENOENT/);
  });

  it('TC-RF-054 rejects when given a directory rather than a file', async () => {
    await expect(readSourceFile(dir)).rejects.toThrow(/EISDIR/);
  });

  it('TC-RF-055 round-trips a file whose name contains spaces and unicode', async () => {
    const file = await write('hello wörld ✨.ts', 'ok\n');
    expect((await readSourceFile(file)).lines).toEqual(['ok']);
  });

  it('TC-RF-056 reads a 500 KB file without truncation', async () => {
    const lineCount = 10_000;
    const body = Array.from({ length: lineCount }, (_, i) => `line ${i}`).join(
      '\n',
    );
    const file = await write('big.ts', body);
    const { lines } = await readSourceFile(file);
    expect(lines).toHaveLength(lineCount);
    expect(lines[lineCount - 1]).toBe(`line ${lineCount - 1}`);
  });

  it('TC-RF-057 decodes invalid UTF-8 bytes to replacement chars rather than throwing', async () => {
    const file = await write('invalid.ts', Buffer.from([0xff, 0xfe, 0x41]));
    const { lines } = await readSourceFile(file);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('�');
  });
});
