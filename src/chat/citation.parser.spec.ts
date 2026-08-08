import { describe, expect, it } from 'vitest';
import { parseCitations, type EvidenceRef } from './citation.parser';

const evidence: EvidenceRef[] = [
  { path: 'src/auth.service.ts', startLine: 1, endLine: 34, content: 'export function validateUser() {}' }, // [1]
  { path: 'src/index.ts', startLine: 1, endLine: 12, content: 'main();' }, // [2]
];

describe('parseCitations', () => {
  it('maps valid markers to their evidence', () => {
    const citations = parseCitations('Auth lives in [1].', evidence);
    expect(citations).toEqual([
      { marker: 1, path: 'src/auth.service.ts', startLine: 1, endLine: 34, content: evidence[0]!.content },
    ]);
  });

  it('drops out-of-range markers', () => {
    const citations = parseCitations('See [1] and [99].', evidence);
    expect(citations).toEqual([
      { marker: 1, path: 'src/auth.service.ts', startLine: 1, endLine: 34, content: evidence[0]!.content },
    ]);
  });

  it('drops markers below 1', () => {
    const citations = parseCitations('Invalid [0] marker.', evidence);
    expect(citations).toEqual([]);
  });

  it('deduplicates a marker cited more than once', () => {
    const citations = parseCitations('[1] does X. Also see [1] again.', evidence);
    expect(citations).toHaveLength(1);
    expect(citations[0]!.marker).toBe(1);
  });

  it('ignores markers that appear only inside a fenced code block', () => {
    const citations = parseCitations('Here:\n```\narr[1] = 2;\n```\nNo real citation.', evidence);
    expect(citations).toEqual([]);
  });

  it('still finds a real citation alongside a fenced code block containing brackets', () => {
    const citations = parseCitations(
      'See [1].\n```\nconst x = arr[1];\n```\n',
      evidence,
    );
    expect(citations).toEqual([
      { marker: 1, path: 'src/auth.service.ts', startLine: 1, endLine: 34, content: evidence[0]!.content },
    ]);
  });

  it('handles adjacent markers', () => {
    const citations = parseCitations('Both apply [1][2].', evidence);
    expect(citations.map((c) => c.marker)).toEqual([1, 2]);
  });

  it('parses [10] as marker ten, not [1] followed by a literal 0', () => {
    const tenEvidence: EvidenceRef[] = [
      ...evidence,
      { path: 'src/utils.ts', startLine: 1, endLine: 19, content: '' },
      { path: 'src/big-module.ts', startLine: 1, endLine: 20, content: '' },
      { path: 'src/big-module.ts', startLine: 20, endLine: 40, content: '' },
      { path: 'src/big-module.ts', startLine: 40, endLine: 60, content: '' },
      { path: 'src/big-module.ts', startLine: 60, endLine: 80, content: '' },
      { path: 'src/big-module.ts', startLine: 80, endLine: 100, content: '' },
      { path: 'src/big-module.ts', startLine: 100, endLine: 120, content: '' },
      { path: 'src/big-module.ts', startLine: 120, endLine: 132, content: 'last chunk' }, // [10]
    ];
    const citations = parseCitations('See [10].', tenEvidence);
    expect(citations).toEqual([
      { marker: 10, path: 'src/big-module.ts', startLine: 120, endLine: 132, content: 'last chunk' },
    ]);
  });

  it('does not confuse [1]0 with a marker 10', () => {
    const citations = parseCitations('The value is [1]0 in binary-ish notation.', evidence);
    expect(citations).toEqual([
      { marker: 1, path: 'src/auth.service.ts', startLine: 1, endLine: 34, content: evidence[0]!.content },
    ]);
  });

  // Some models substitute their own trained-in citation style no matter how
  // the prompt is worded — observed live from Groq's openai/gpt-oss-120b.
  it('also recognizes the 【n】 citation style some models substitute for [n]', () => {
    const citations = parseCitations('Auth lives in 【1】.', evidence);
    expect(citations).toEqual([
      { marker: 1, path: 'src/auth.service.ts', startLine: 1, endLine: 34, content: evidence[0]!.content },
    ]);
  });

  it('recognizes 【n†...】 (with a trailing line-range annotation) too', () => {
    const citations = parseCitations('Auth lives in 【1†L9-L15】.', evidence);
    expect(citations).toEqual([
      { marker: 1, path: 'src/auth.service.ts', startLine: 1, endLine: 34, content: evidence[0]!.content },
    ]);
  });

  it('ignores a 【n】 marker inside a fenced code block, same as [n]', () => {
    const citations = parseCitations('Here:\n```\narr【1】 = 2;\n```\nNo real citation.', evidence);
    expect(citations).toEqual([]);
  });

  it('dedupes and range-checks 【n】 the same way as [n]', () => {
    const citations = parseCitations('【1】 and 【1】 again, but not 【99】.', evidence);
    expect(citations).toEqual([
      { marker: 1, path: 'src/auth.service.ts', startLine: 1, endLine: 34, content: evidence[0]!.content },
    ]);
  });

  it('preserves in-text order across mixed [n] and 【n】 markers', () => {
    const citations = parseCitations('First 【2】, then [1].', evidence);
    expect(citations.map((c) => c.marker)).toEqual([2, 1]);
  });
});
