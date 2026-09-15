import { describe, it, expect } from 'vitest';
import { sha256 } from './hash';

/**
 * QA pass — TC-HASH-*.
 *
 * `sha256` backs `files.contentHash`, which is what decides whether a file is
 * re-indexed. Two properties matter: it must be stable across runs (or every
 * index re-embeds the whole repo), and it must change whenever the content
 * changes (or an edit is silently ignored).
 */
describe('sha256', () => {
  it('TC-HASH-001 returns a 64-character lowercase hex digest', () => {
    expect(sha256('hello')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('TC-HASH-002 matches the known digest for a fixed input', () => {
    // Pinned against the published SHA-256 of "abc". Guards against an
    // accidental change of algorithm or encoding.
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('TC-HASH-003 hashes the empty string to the well-known digest', () => {
    expect(sha256('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('TC-HASH-004 is deterministic across repeated calls', () => {
    const input = 'const x = 1;\n';
    expect(sha256(input)).toBe(sha256(input));
  });

  it('TC-HASH-005 changes when a single character changes', () => {
    expect(sha256('const x = 1;')).not.toBe(sha256('const x = 2;'));
  });

  it('TC-HASH-006 distinguishes a trailing newline', () => {
    // Relevant because `toLines` drops a structural trailing newline from
    // `lines` but `text` keeps it — the two must not be conflated at hash time.
    expect(sha256('a')).not.toBe(sha256('a\n'));
  });

  it('TC-HASH-007 distinguishes CRLF from LF', () => {
    expect(sha256('a\r\nb')).not.toBe(sha256('a\nb'));
  });

  it('TC-HASH-008 distinguishes a BOM-prefixed string from a bare one', () => {
    // See DEF-001 — a BOM survives the read path, so it reaches the hash.
    expect(sha256('\uFEFFconst x = 1;')).not.toBe(sha256('const x = 1;'));
  });

  it('TC-HASH-009 hashes unicode deterministically via UTF-8', () => {
    const emoji = 'const flag = "🇯🇵";';
    expect(sha256(emoji)).toBe(sha256(emoji));
    expect(sha256(emoji)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('TC-HASH-010 distinguishes strings differing only in whitespace', () => {
    expect(sha256('a b')).not.toBe(sha256('a  b'));
    expect(sha256('a\tb')).not.toBe(sha256('a b'));
  });

  it('TC-HASH-011 handles a 1 MB input', () => {
    const big = 'x'.repeat(1_000_000);
    expect(sha256(big)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(big)).not.toBe(sha256(big + 'y'));
  });

  it('TC-HASH-012 produces distinct digests across a large set of similar inputs', () => {
    // Cheap collision sanity check: 1,000 near-identical strings must all differ.
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(sha256(`line ${i}`));
    expect(seen.size).toBe(1000);
  });
});
