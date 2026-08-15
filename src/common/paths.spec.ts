import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveInside, toNative, toPosix } from './paths';

describe('toPosix / toNative', () => {
  it('round-trips through the platform separator', () => {
    const native = ['a', 'b', 'c'].join(path.sep);
    expect(toPosix(native)).toBe('a/b/c');
    expect(toNative('a/b/c')).toBe(native);
  });
});

describe('resolveInside', () => {
  const root = path.resolve('D:/fake/project/root');

  it('resolves a plain repo-relative path under the root', () => {
    expect(resolveInside(root, 'src/index.ts')).toBe(path.join(root, 'src', 'index.ts'));
  });

  it('resolves the root itself', () => {
    expect(resolveInside(root, '.')).toBe(root);
  });

  it('rejects a relative traversal above the root', () => {
    expect(() => resolveInside(root, '../../etc/passwd')).toThrow(/escapes root/);
  });

  it('rejects a traversal that uses backslashes', () => {
    expect(() => resolveInside(root, '..\\..\\etc\\passwd')).toThrow(/escapes root/);
  });

  it('rejects an absolute path on a different drive', () => {
    expect(() => resolveInside(root, 'C:/Windows/win.ini')).toThrow(/escapes root/);
  });

  it('rejects a sibling directory that merely shares a name prefix', () => {
    // "root-evil" starts with "root" as a string but is not inside it —
    // the check must compare path segments (via `path.sep`), not string prefix.
    expect(() => resolveInside(root, `../${path.basename(root)}-evil/secret.txt`)).toThrow(
      /escapes root/,
    );
  });

  it('rejects a UNC path', () => {
    // Phase 6's acceptance test names UNC paths explicitly in its
    // path-traversal table, alongside `../`, `..\`, absolute, and `C:\`.
    expect(() => resolveInside(root, '\\\\server\\share\\secret.txt')).toThrow(/escapes root/);
  });
});
