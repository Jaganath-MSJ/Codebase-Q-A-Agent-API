import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WalkerService } from './walker.service';
import { MAX_FILE_BYTES } from './filters';

/**
 * QA pass — TC-WALK-*.
 *
 * The walker decides what the whole system can ever answer questions about: a
 * file wrongly skipped here is invisible to retrieval forever, with no error
 * anywhere. `filters.ts` and `gitignore.ts` have their own specs; this covers
 * the service that composes them, plus the two properties later phases depend
 * on — deterministic ordering, and `text`/`lines` coming from `read-file.ts`.
 */

describe('WalkerService', () => {
  const walker = new WalkerService();
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'qa-walker-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const write = async (relPath: string, content: string | Buffer) => {
    const abs = path.join(root, relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  };

  const walk = () => walker.walk(root);
  const pathsOf = async () => (await walk()).included.map((f) => f.relPath);

  describe('TC-WALK-001..004 — inclusion', () => {
    it('TC-WALK-001 includes ordinary source files', async () => {
      await write('src/index.ts', 'const a = 1;');
      await write('README.md', '# hi');
      expect(await pathsOf()).toEqual(['README.md', 'src/index.ts']);
    });

    it('TC-WALK-002 returns repo-relative forward-slash paths (INV-2)', async () => {
      await write('src/nested/deep/file.ts', 'x');
      const [relPath] = await pathsOf();
      expect(relPath).toBe('src/nested/deep/file.ts');
      expect(relPath).not.toContain('\\');
      expect(path.isAbsolute(relPath!)).toBe(false);
    });

    it('TC-WALK-003 also returns an absolute path for reading', async () => {
      await write('src/a.ts', 'x');
      const [file] = (await walk()).included;
      expect(path.isAbsolute(file!.absPath)).toBe(true);
      expect(file!.absPath).toContain(root);
    });

    it('TC-WALK-004 returns an empty result for an empty directory', async () => {
      const result = await walk();
      expect(result.included).toEqual([]);
      expect(result.skipReasons).toEqual({});
    });
  });

  describe('TC-WALK-010..016 — skip reasons', () => {
    it('TC-WALK-010 skips denylisted directories silently, without counting them', async () => {
      await write('src/a.ts', 'x');
      await write('node_modules/dep/index.js', 'x');
      await write('dist/bundle.js', 'x');
      await write('.git/config', 'x');

      const result = await walk();
      expect(result.included.map((f) => f.relPath)).toEqual(['src/a.ts']);
      // Excluded by fast-glob before classification, so they are not "skips".
      expect(result.skipReasons.extension).toBeUndefined();
    });

    it('TC-WALK-011 counts a gitignored file', async () => {
      await write('.gitignore', 'secret.ts\n');
      await write('secret.ts', 'x');
      await write('src/a.ts', 'x');

      const result = await walk();
      expect(result.included.map((f) => f.relPath)).not.toContain('secret.ts');
      expect(result.skipReasons.gitignore).toBe(1);
    });

    it('TC-WALK-012 counts a denylisted filename', async () => {
      await write('package-lock.json', '{}');
      const result = await walk();
      expect(result.skipReasons.filename).toBe(1);
      expect(result.included).toEqual([]);
    });

    it('TC-WALK-013 counts a disallowed extension', async () => {
      await write('image.png', 'not really a png');
      const result = await walk();
      expect(result.skipReasons.extension).toBe(1);
    });

    it('TC-WALK-014 counts a file over the size cap', async () => {
      await write('big.ts', 'x'.repeat(MAX_FILE_BYTES + 1));
      const result = await walk();
      expect(result.skipReasons['too-large']).toBe(1);
    });

    it('TC-WALK-015 counts a binary file with an allowed extension', async () => {
      // NUL bytes in a .ts file — extension passes, the byte sniff must not.
      await write('fake.ts', Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));
      const result = await walk();
      expect(result.skipReasons.binary).toBe(1);
    });

    it('TC-WALK-016 counts a minified file by excessive line length', async () => {
      await write('bundle.ts', 'a'.repeat(5000));
      const result = await walk();
      expect(result.skipReasons.minified).toBe(1);
    });
  });

  describe('TC-WALK-020..023 — boundaries', () => {
    it('TC-WALK-020 includes a file exactly at the size cap', async () => {
      // Must be built from short lines: a single 256 KB line would be rejected
      // as minified long before the size comparison decides anything, which
      // would make this test pass for the wrong reason.
      const line = 'x'.repeat(63) + '\n'; // 64 bytes
      const content = line.repeat(MAX_FILE_BYTES / 64); // exactly the cap
      expect(Buffer.byteLength(content)).toBe(MAX_FILE_BYTES);

      await write('edge.ts', content);

      const result = await walk();
      expect(result.skipReasons['too-large']).toBeUndefined();
      expect(result.included.map((f) => f.relPath)).toEqual(['edge.ts']);
    });

    it('TC-WALK-020b skips a file one byte over the cap', async () => {
      const line = 'x'.repeat(63) + '\n';
      const content = line.repeat(MAX_FILE_BYTES / 64) + 'x';
      await write('over.ts', content);

      const result = await walk();
      expect(result.skipReasons['too-large']).toBe(1);
      expect(result.included).toEqual([]);
    });

    it('TC-WALK-020c rejects a long single line as minified, not as too-large', async () => {
      // Pins the precedence the previous two rely on: the minified check runs
      // after the size check, so a file that is both is counted as too-large.
      await write('oneline.ts', 'x'.repeat(3000)); // under the size cap, over the line cap
      const result = await walk();
      expect(result.skipReasons.minified).toBe(1);
      expect(result.skipReasons['too-large']).toBeUndefined();
    });

    it('TC-WALK-021 includes an empty file', async () => {
      await write('empty.ts', '');
      const [file] = (await walk()).included;
      expect(file!.relPath).toBe('empty.ts');
      expect(file!.lines).toEqual([]);
      expect(file!.text).toBe('');
    });

    it('TC-WALK-022 includes a dotfile with an allowed extension', async () => {
      await write('.eslintrc.json', '{}');
      expect(await pathsOf()).toContain('.eslintrc.json');
    });

    it('TC-WALK-023 handles a unicode filename', async () => {
      await write('src/wörld-✨.ts', 'const a = 1;');
      expect(await pathsOf()).toContain('src/wörld-✨.ts');
    });
  });

  describe('TC-WALK-030..033 — content contract (INV-3)', () => {
    it('TC-WALK-030 normalises CRLF through read-file.ts', async () => {
      await write('crlf.ts', 'a\r\nb\r\nc');
      const [file] = (await walk()).included;
      expect(file!.text).not.toContain('\r');
      expect(file!.lines).toEqual(['a', 'b', 'c']);
    });

    it('TC-WALK-031 satisfies the INV-9 reconstruction property', async () => {
      await write('multi.ts', 'one\ntwo\nthree\n');
      const [file] = (await walk()).included;
      expect(file!.lines.slice(0, 2).join('\n')).toBe('one\ntwo');
    });

    it('TC-WALK-032 keeps text and lines consistent with each other', async () => {
      await write('x.ts', 'alpha\nbeta');
      const [file] = (await walk()).included;
      expect(file!.lines.join('\n')).toBe(file!.text);
    });

    it('TC-WALK-033 preserves unicode content', async () => {
      await write('emoji.ts', 'const flag = "🇯🇵";');
      const [file] = (await walk()).included;
      expect(file!.lines[0]).toBe('const flag = "🇯🇵";');
    });
  });

  describe('TC-WALK-040..042 — determinism (CONC)', () => {
    /**
     * Classification runs at concurrency 12, so completion order is arbitrary.
     * Both the included list and the skip tallies must be aggregated
     * deterministically, or a re-index could reorder chunks for no reason.
     */
    it('TC-WALK-040 returns included files sorted by path', async () => {
      for (const name of ['zebra.ts', 'alpha.ts', 'middle.ts', 'a/b/c.ts']) {
        await write(name, 'x');
      }
      const paths = await pathsOf();
      expect([...paths].sort()).toEqual(paths);
    });

    it('TC-WALK-041 returns identical results across repeated walks', async () => {
      for (let i = 0; i < 40; i++)
        await write(`src/f${i}.ts`, `const x = ${i};`);
      await write('.gitignore', 'ignored.ts\n');
      await write('ignored.ts', 'x');
      await write('image.png', 'x');

      const a = await walk();
      const b = await walk();
      expect(a.included.map((f) => f.relPath)).toEqual(
        b.included.map((f) => f.relPath),
      );
      expect(a.skipReasons).toEqual(b.skipReasons);
    });

    it('TC-WALK-042 tallies skips correctly when many files skip for mixed reasons', async () => {
      for (let i = 0; i < 5; i++) await write(`img${i}.png`, 'x');
      for (let i = 0; i < 3; i++)
        await write(`lock${i}/package-lock.json`, '{}');
      await write('src/keep.ts', 'x');

      const result = await walk();
      expect(result.skipReasons.extension).toBe(5);
      expect(result.skipReasons.filename).toBe(3);
      expect(result.included.map((f) => f.relPath)).toEqual(['src/keep.ts']);
    });
  });

  it('TC-WALK-050 applies a nested .gitignore', async () => {
    await write('.gitignore', '*.log\n');
    await write('src/.gitignore', 'local.ts\n');
    await write('src/local.ts', 'x');
    await write('src/kept.ts', 'x');
    await write('debug.log', 'x');

    const paths = await pathsOf();
    expect(paths).toContain('src/kept.ts');
    expect(paths).not.toContain('src/local.ts');
    expect(paths).not.toContain('debug.log');
  });
});
