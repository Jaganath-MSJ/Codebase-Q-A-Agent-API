import { describe, it, expect } from 'vitest';
import { GITHUB_URL_RE, SAFE_BRANCH_RE } from './git-clone';

/**
 * QA pass — TC-SRC-0xx / TC-SRC-1xx.
 *
 * Both constants guard values that reach a `git` subprocess. They are passed as
 * argv entries rather than a shell string, so this is not shell-injection
 * defence — it is defence against argument injection (a branch beginning `-`
 * becoming `--upload-pack=…`) and against pointing the cloner somewhere other
 * than GitHub. Pure regexes, so they are cheap to pin exhaustively.
 */

describe('GITHUB_URL_RE', () => {
  describe('TC-SRC-001..006 — URLs that must be accepted', () => {
    const valid = [
      ['TC-SRC-001', 'https://github.com/owner/repo'],
      ['TC-SRC-002', 'https://github.com/owner/repo.git'],
      ['TC-SRC-003', 'https://github.com/owner/repo/'],
      ['TC-SRC-004', 'https://github.com/owner/repo.git/'],
      ['TC-SRC-005', 'https://github.com/my-org/my.repo-name'],
      ['TC-SRC-006', 'https://github.com/a/b'],
    ] as const;

    for (const [id, url] of valid) {
      it(`${id} accepts ${url}`, () => {
        expect(GITHUB_URL_RE.test(url)).toBe(true);
      });
    }
  });

  describe('TC-SRC-010..023 — URLs that must be rejected (SEC)', () => {
    const invalid = [
      ['TC-SRC-010', 'plain http', 'http://github.com/owner/repo'],
      ['TC-SRC-011', 'another host', 'https://gitlab.com/owner/repo'],
      [
        'TC-SRC-012',
        'lookalike suffix host',
        'https://github.com.evil.com/o/r',
      ],
      ['TC-SRC-013', 'lookalike prefix host', 'https://evilgithub.com/o/r'],
      ['TC-SRC-014', 'host in the path', 'https://evil.com/github.com/o/r'],
      [
        'TC-SRC-015',
        'embedded credentials',
        'https://user:pass@github.com/o/r',
      ],
      ['TC-SRC-016', 'userinfo confusion', 'https://github.com@evil.com/o/r'],
      ['TC-SRC-017', 'explicit port', 'https://github.com:8080/o/r'],
      ['TC-SRC-018', 'missing repo segment', 'https://github.com/owner'],
      ['TC-SRC-019', 'extra path segment', 'https://github.com/o/r/tree/main'],
      ['TC-SRC-020', 'query string', 'https://github.com/o/r?x=1'],
      ['TC-SRC-021', 'fragment', 'https://github.com/o/r#frag'],
      ['TC-SRC-022', 'ssh scheme', 'git@github.com:owner/repo.git'],
      ['TC-SRC-023', 'file scheme', 'file:///etc/passwd'],
      ['TC-SRC-024', 'empty string', ''],
      ['TC-SRC-025', 'space in repo name', 'https://github.com/o/my repo'],
      ['TC-SRC-026', 'shell metacharacter', 'https://github.com/o/r;whoami'],
      ['TC-SRC-027', 'backtick', 'https://github.com/o/r`id`'],
    ] as const;

    for (const [id, label, url] of invalid) {
      it(`${id} rejects ${label}: ${JSON.stringify(url)}`, () => {
        expect(GITHUB_URL_RE.test(url)).toBe(false);
      });
    }
  });

  describe('TC-SRC-030..032 — anchoring', () => {
    it('TC-SRC-030 rejects a trailing newline (JS $ is strict, unlike some languages)', () => {
      // In Python or Ruby `$` would match before a trailing newline, making
      // "https://github.com/o/r\nevil" a classic bypass. JS anchors at end of
      // input. Pinned so a future port of this rule cannot silently regress.
      expect(GITHUB_URL_RE.test('https://github.com/o/r\n')).toBe(false);
      expect(
        GITHUB_URL_RE.test('https://github.com/o/r\nhttps://evil.com'),
      ).toBe(false);
    });

    it('TC-SRC-031 rejects leading whitespace', () => {
      expect(GITHUB_URL_RE.test(' https://github.com/o/r')).toBe(false);
    });

    it('TC-SRC-032 rejects a carriage return anywhere', () => {
      expect(GITHUB_URL_RE.test('https://github.com/o/r\r')).toBe(false);
    });
  });

  describe('TC-SRC-040..041 — documented looseness', () => {
    it('TC-SRC-040 [DEFECT-005 fixed] accepts any casing of the host', () => {
      // DNS hostnames are case-insensitive, so a URL the browser and `git` both
      // accept must not be rejected here. Was DEF-005.
      expect(GITHUB_URL_RE.test('https://GitHub.com/owner/repo')).toBe(true);
      expect(GITHUB_URL_RE.test('https://GITHUB.COM/owner/repo')).toBe(true);
      expect(GITHUB_URL_RE.test('https://github.com/owner/repo')).toBe(true);
    });

    it('TC-SRC-042 [DEFECT-005 fix guard] keeps owner and repo case-sensitive', () => {
      // The reason the fix spells the host out character by character instead
      // of adding an `/i` flag: a blanket flag would loosen these segments too,
      // and GitHub preserves their case. Matching is not the same as equality —
      // both spellings are valid URLs, so both must match; what must NOT happen
      // is the pattern silently treating them as interchangeable elsewhere.
      expect(GITHUB_URL_RE.test('https://github.com/OWNER/Repo')).toBe(true);
      // The host class is exactly six characters wide — no other host slips in.
      expect(GITHUB_URL_RE.test('https://githubXcom/owner/repo')).toBe(false);
      expect(GITHUB_URL_RE.test('https://notgithub.com/owner/repo')).toBe(
        false,
      );
      expect(GITHUB_URL_RE.test('https://github.com.evil.tld/owner/repo')).toBe(
        false,
      );
    });

    it('TC-SRC-041 allows dots in the owner and repo segments', () => {
      // `[\w.-]+` permits ".." inside a segment. Harmless here — the string is
      // sent to GitHub as a URL, not used as a local path — but worth pinning
      // so nobody later reuses this regex for a filesystem path.
      expect(GITHUB_URL_RE.test('https://github.com/owner/..')).toBe(true);
    });
  });
});

describe('SAFE_BRANCH_RE', () => {
  describe('TC-SRC-100..106 — branch names that must be accepted', () => {
    const valid = [
      ['TC-SRC-100', 'main'],
      ['TC-SRC-101', 'master'],
      ['TC-SRC-102', 'feature/my-branch'],
      ['TC-SRC-103', 'refs/heads/main'],
      ['TC-SRC-104', 'release-1.2.3'],
      ['TC-SRC-105', 'v2'],
      ['TC-SRC-106', 'user.name/topic'],
    ] as const;

    for (const [id, branch] of valid) {
      it(`${id} accepts ${JSON.stringify(branch)}`, () => {
        expect(SAFE_BRANCH_RE.test(branch)).toBe(true);
      });
    }
  });

  describe('TC-SRC-110..122 — branch names that must be rejected (SEC)', () => {
    const invalid = [
      ['TC-SRC-110', 'argument injection', '--upload-pack=touch /tmp/pwned'],
      ['TC-SRC-111', 'single dash flag', '-x'],
      ['TC-SRC-112', 'leading dash', '-main'],
      ['TC-SRC-113', 'double-dot traversal', 'feature/../../../etc'],
      ['TC-SRC-114', 'bare double dot', '..'],
      ['TC-SRC-115', 'double dot inside', 'a..b'],
      ['TC-SRC-116', 'space', 'my branch'],
      ['TC-SRC-117', 'semicolon', 'main;whoami'],
      ['TC-SRC-118', 'backtick', 'main`id`'],
      ['TC-SRC-119', 'dollar expansion', 'main$(id)'],
      ['TC-SRC-120', 'newline', 'main\nevil'],
      ['TC-SRC-121', 'empty string', ''],
      ['TC-SRC-122', 'ampersand', 'main&&id'],
    ] as const;

    for (const [id, label, branch] of invalid) {
      it(`${id} rejects ${label}: ${JSON.stringify(branch)}`, () => {
        expect(SAFE_BRANCH_RE.test(branch)).toBe(false);
      });
    }
  });

  it('TC-SRC-130 rejects a trailing newline', () => {
    expect(SAFE_BRANCH_RE.test('main\n')).toBe(false);
  });

  it('TC-SRC-131 has no catastrophic backtracking on a long hostile input', () => {
    const start = performance.now();
    SAFE_BRANCH_RE.test('a.'.repeat(5000) + '!');
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
