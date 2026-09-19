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
    expect(resolveInside(root, 'src/index.ts')).toBe(
      path.join(root, 'src', 'index.ts'),
    );
  });

  it('resolves the root itself', () => {
    expect(resolveInside(root, '.')).toBe(root);
  });

  it('rejects a relative traversal above the root', () => {
    expect(() => resolveInside(root, '../../etc/passwd')).toThrow(
      /escapes root/,
    );
  });

  it('rejects a traversal that uses backslashes', () => {
    expect(() => resolveInside(root, '..\\..\\etc\\passwd')).toThrow(
      /escapes root/,
    );
  });

  it('rejects an absolute path on a different drive', () => {
    expect(() => resolveInside(root, 'C:/Windows/win.ini')).toThrow(
      /escapes root/,
    );
  });

  it('rejects a sibling directory that merely shares a name prefix', () => {
    // "root-evil" starts with "root" as a string but is not inside it —
    // the check must compare path segments (via `path.sep`), not string prefix.
    expect(() =>
      resolveInside(root, `../${path.basename(root)}-evil/secret.txt`),
    ).toThrow(/escapes root/);
  });

  it('rejects a UNC path', () => {
    // The acceptance test names UNC paths explicitly in its path-traversal
    // table, alongside `../`, `..\`, absolute, and `C:\`.
    expect(() => resolveInside(root, '\\\\server\\share\\secret.txt')).toThrow(
      /escapes root/,
    );
  });

  it('rejects a Windows drive-relative path', () => {
    // `C:foo` (no slash after the drive) is drive-*relative* — path.isAbsolute
    // reports false for it, but it still refers off the intended root, so the
    // guard must reject it on any host. Same for a drive-relative traversal.
    expect(() => resolveInside(root, 'C:secret.txt')).toThrow(/escapes root/);
    expect(() => resolveInside(root, 'C:../../etc/passwd')).toThrow(
      /escapes root/,
    );
  });
});

/**
 * QA pass — TC-PATH-*. Extends the cases above with the traversal shapes a
 * model-chosen `read_file` argument can realistically take (INV-2 / SEC), plus
 * a fuzz sweep asserting the containment property rather than individual inputs.
 */
describe('resolveInside — QA traversal matrix', () => {
  const root = path.resolve('/fake/project/root');
  const inside = (p: string) => resolveInside(root, p);

  describe('TC-PATH-100..108 — escapes that must be rejected', () => {
    const hostile = [
      ['TC-PATH-100', 'POSIX absolute', '/etc/passwd'],
      ['TC-PATH-101', 'single parent hop', '../secret'],
      ['TC-PATH-102', 'bare parent', '..'],
      ['TC-PATH-103', 'interior climb past root', 'src/../../../etc/passwd'],
      ['TC-PATH-104', 'leading current-dir then climb', './../../etc/passwd'],
      ['TC-PATH-105', 'backslash parent', '..\\secret'],
      ['TC-PATH-106', 'mixed separators climbing', '..\\../etc/passwd'],
      ['TC-PATH-107', 'drive absolute forward slash', 'C:/Windows/win.ini'],
      ['TC-PATH-108', 'UNC share', '\\\\server\\share\\x'],
    ] as const;

    for (const [id, label, candidate] of hostile) {
      it(`${id} rejects ${label}: ${JSON.stringify(candidate)}`, () => {
        expect(() => inside(candidate)).toThrow(/escapes root/);
      });
    }
  });

  describe('TC-PATH-120..127 — legitimate paths that must resolve inside', () => {
    const benign = [
      ['TC-PATH-120', 'nested file', 'src/a/b/c.ts'],
      ['TC-PATH-121', 'interior climb that stays inside', 'src/x/../y.ts'],
      ['TC-PATH-122', 'current-dir prefix', './src/index.ts'],
      ['TC-PATH-123', 'filename with spaces', 'src/my file.ts'],
      ['TC-PATH-124', 'unicode filename', 'src/wörld-✨.ts'],
      ['TC-PATH-125', 'hash and question mark', 'src/a#b?c.ts'],
      ['TC-PATH-126', 'dotfile', '.gitignore'],
      ['TC-PATH-127', 'name merely starting with dots', '...weird.ts'],
    ] as const;

    for (const [id, label, candidate] of benign) {
      it(`${id} accepts ${label}: ${JSON.stringify(candidate)}`, () => {
        const resolved = inside(candidate);
        expect(resolved === root || resolved.startsWith(root + path.sep)).toBe(
          true,
        );
      });
    }
  });

  describe('TC-PATH-140..143 — boundary shapes', () => {
    it('TC-PATH-140 resolves the empty string to the root itself', () => {
      expect(inside('')).toBe(root);
    });

    it('TC-PATH-141 accepts a deeply nested path', () => {
      const deep = Array.from({ length: 100 }, (_, i) => `d${i}`).join('/');
      expect(inside(deep).startsWith(root + path.sep)).toBe(true);
    });

    it('TC-PATH-142 treats a percent-encoded traversal as a literal name', () => {
      // `resolveInside` deliberately does NOT URL-decode. "..%2f" is therefore
      // an ordinary (if odd) directory name, not a climb — decoding here would
      // be the bug, since callers pass already-decoded repo-relative paths.
      const resolved = inside('..%2fetc/passwd');
      expect(resolved.startsWith(root + path.sep)).toBe(true);
    });

    it('TC-PATH-143 keeps a NUL byte contained rather than escaping', () => {
      // Containment still holds; the NUL is rejected later by the fs layer,
      // which is the right place for it. Asserted so a future change that starts
      // splitting on NUL cannot silently open an escape.
      const resolved = inside('src/a\u0000b.ts');
      expect(resolved.startsWith(root + path.sep)).toBe(true);
    });
  });

  it('TC-PATH-160 fuzz: no generated candidate ever resolves outside the root', () => {
    // The property, not the examples: whatever `resolveInside` returns, it is
    // either the root or strictly beneath it — otherwise it must have thrown.
    const segments = [
      '..',
      '.',
      'a',
      'b c',
      '..\\',
      'C:',
      '',
      'x.ts',
      '\u2728',
    ];
    const separators = ['/', '\\'];
    let accepted = 0;
    let rejected = 0;

    for (let trial = 0; trial < 1500; trial++) {
      const length = 1 + (trial % 5);
      const candidate = Array.from({ length }, (_, i) => {
        const seg = segments[(trial * 7 + i * 3) % segments.length]!;
        const sep = separators[(trial + i) % separators.length]!;
        return i === length - 1 ? seg : seg + sep;
      }).join('');

      try {
        const resolved = resolveInside(root, candidate);
        accepted++;
        expect(resolved === root || resolved.startsWith(root + path.sep)).toBe(
          true,
        );
      } catch (err) {
        rejected++;
        expect((err as Error).message).toMatch(/escapes root/);
      }
    }

    // Guard against a vacuous pass: the corpus must exercise both branches.
    expect(accepted).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  });
});

describe('toPosix / toNative — QA notes', () => {
  it('TC-PATH-180 round-trips an arbitrary repo-relative path', () => {
    const posix = 'src/features/chat/ChatPanel.tsx';
    expect(toPosix(toNative(posix))).toBe(posix);
  });

  it('TC-PATH-181 leaves an already-posix path unchanged on a posix host', () => {
    expect(toPosix('a/b/c')).toBe('a/b/c');
  });

  it('TC-PATH-182 documents that conversion is host-separator dependent', () => {
    // `toPosix` splits on `path.sep`, so on a POSIX host a literal backslash is
    // NOT a separator and survives untouched; on Windows it would become "/".
    // This is correct — it converts *native* separators — but it means the
    // Windows behaviour of these two helpers cannot be exercised here.
    // Recorded as a coverage gap in TRACEABILITY.md rather than asserted falsely.
    const withBackslash = 'a\\b';
    expect(toPosix(withBackslash)).toBe(
      path.sep === '\\' ? 'a/b' : withBackslash,
    );
  });
});
