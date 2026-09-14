import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { loadGitignoreFilter } from './gitignore';

describe('loadGitignoreFilter', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gitignore-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('ignores paths matched by a root .gitignore', async () => {
    await writeFile(path.join(root, '.gitignore'), '*.log\nbuild\n');

    const filter = await loadGitignoreFilter(root, ['.gitignore']);

    expect(filter.isIgnored('app.log')).toBe(true);
    expect(filter.isIgnored('build/output.js')).toBe(true);
    expect(filter.isIgnored('src/index.ts')).toBe(false);
  });

  it('scopes a nested .gitignore to its own directory, not the whole repo', async () => {
    await mkdir(path.join(root, 'pkg'), { recursive: true });
    await writeFile(path.join(root, '.gitignore'), 'dist\n');
    await writeFile(path.join(root, 'pkg', '.gitignore'), '*.log\n');

    const filter = await loadGitignoreFilter(root, [
      '.gitignore',
      'pkg/.gitignore',
    ]);

    // pkg's *.log rule applies inside pkg...
    expect(filter.isIgnored('pkg/debug.log')).toBe(true);
    // ...but not outside it, even though the pattern text is identical.
    expect(filter.isIgnored('debug.log')).toBe(false);
    // the root's `dist` rule applies everywhere under the root, including pkg.
    expect(filter.isIgnored('dist/x.js')).toBe(true);
  });

  it('matches nested .gitignore patterns at any depth within their own directory', async () => {
    await mkdir(path.join(root, 'pkg', 'deep'), { recursive: true });
    await writeFile(path.join(root, 'pkg', '.gitignore'), '*.log\n');

    const filter = await loadGitignoreFilter(root, ['pkg/.gitignore']);

    expect(filter.isIgnored('pkg/deep/debug.log')).toBe(true);
  });

  it('also loads a project-level .cqaignore at the root', async () => {
    await writeFile(path.join(root, '.cqaignore'), 'secrets/\n');

    const filter = await loadGitignoreFilter(root, []);

    expect(filter.isIgnored('secrets/key.pem')).toBe(true);
    expect(filter.isIgnored('src/index.ts')).toBe(false);
  });

  it('returns a no-op filter when there is nothing to load', async () => {
    const filter = await loadGitignoreFilter(root, []);
    expect(filter.isIgnored('src/index.ts')).toBe(false);
  });
});
