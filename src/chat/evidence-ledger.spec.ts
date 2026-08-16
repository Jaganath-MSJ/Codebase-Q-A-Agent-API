import { describe, expect, it } from 'vitest';
import { formatEvidenceEntry, recordEvidence } from './evidence-ledger';

describe('recordEvidence', () => {
  it('assigns 1-based markers starting from an empty ledger', () => {
    const created = recordEvidence([], [
      { path: 'src/a.ts', startLine: 1, endLine: 5, content: 'a' },
      { path: 'src/b.ts', startLine: 10, endLine: 12, content: 'b' },
    ]);
    expect(created.map((e) => e.marker)).toEqual([1, 2]);
  });

  it('continues numbering from however many entries already exist', () => {
    const existing = recordEvidence([], [{ path: 'src/a.ts', startLine: 1, endLine: 5, content: 'a' }]);
    const created = recordEvidence(existing, [
      { path: 'src/b.ts', startLine: 10, endLine: 12, content: 'b' },
      { path: 'src/c.ts', startLine: 20, endLine: 22, content: 'c' },
    ]);
    expect(created.map((e) => e.marker)).toEqual([2, 3]);
  });

  it('returns an empty array for an empty region list, without touching numbering', () => {
    const existing = recordEvidence([], [{ path: 'src/a.ts', startLine: 1, endLine: 5, content: 'a' }]);
    expect(recordEvidence(existing, [])).toEqual([]);
  });

  it('preserves region fields verbatim alongside the assigned marker', () => {
    const [entry] = recordEvidence([], [{ path: 'src/auth.service.ts', startLine: 41, endLine: 88, content: 'code' }]);
    expect(entry).toEqual({ path: 'src/auth.service.ts', startLine: 41, endLine: 88, content: 'code', marker: 1 });
  });
});

describe('formatEvidenceEntry', () => {
  it('renders the [n] path:start-end block with a fenced content body', () => {
    const text = formatEvidenceEntry({
      marker: 7,
      path: 'src/auth/auth.service.ts',
      startLine: 41,
      endLine: 88,
      content: 'async function validateUser() {}',
    });
    expect(text).toBe(
      '[7] src/auth/auth.service.ts:41-88\n```\nasync function validateUser() {}\n```',
    );
  });
});
