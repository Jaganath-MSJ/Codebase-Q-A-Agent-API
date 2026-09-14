import { describe, expect, it } from 'vitest';
import {
  countInboundImports,
  isConfigFile,
  isDocFile,
  isEntryPoint,
  rankFiles,
  scoreFile,
  type RankableFile,
} from './file-ranking';

describe('isEntryPoint', () => {
  it('matches known entry-point basenames regardless of directory', () => {
    expect(isEntryPoint('src/main.ts')).toBe(true);
    expect(isEntryPoint('src/app.module.ts')).toBe(true);
    expect(isEntryPoint('src/utils.ts')).toBe(false);
  });
});

describe('isConfigFile', () => {
  it('matches common config filenames', () => {
    expect(isConfigFile('package.json')).toBe(true);
    expect(isConfigFile('tsconfig.build.json')).toBe(true);
    expect(isConfigFile('vite.config.ts')).toBe(true);
    expect(isConfigFile('src/db/schema.ts')).toBe(true);
    expect(isConfigFile('src/index.ts')).toBe(false);
  });
});

describe('isDocFile', () => {
  it('matches markdown extensions only', () => {
    expect(isDocFile('README.md')).toBe(true);
    expect(isDocFile('docs/GUIDE.mdx')).toBe(true);
    expect(isDocFile('src/index.ts')).toBe(false);
  });
});

describe('countInboundImports', () => {
  it('resolves a relative import to the importing file, trying known extensions', () => {
    const files: RankableFile[] = [
      { path: 'src/index.ts', content: `import { helper } from './utils';` },
      { path: 'src/utils.ts', content: 'export function helper() {}' },
    ];
    expect(countInboundImports(files).get('src/utils.ts')).toBe(1);
  });

  it('resolves a parent-directory import to an index file', () => {
    const files: RankableFile[] = [
      {
        path: 'src/chat/chat.service.ts',
        content: `import { db } from '../db';`,
      },
      { path: 'src/db/index.ts', content: 'export const db = {};' },
    ];
    expect(countInboundImports(files).get('src/db/index.ts')).toBe(1);
  });

  it('ignores bare package imports and unresolvable specifiers', () => {
    const files: RankableFile[] = [
      {
        path: 'src/index.ts',
        content: `import { z } from 'zod';\nimport x from './missing';`,
      },
    ];
    expect(countInboundImports(files).size).toBe(0);
  });

  it('does not count a file importing itself', () => {
    const files: RankableFile[] = [
      { path: 'src/index.ts', content: `import { x } from './index';` },
    ];
    expect(countInboundImports(files).get('src/index.ts')).toBeUndefined();
  });
});

describe('scoreFile', () => {
  it('scores an entry point above a plain file with no other signal', () => {
    const entry = scoreFile({ path: 'src/main.ts', content: '' }, 0, 0);
    const plain = scoreFile({ path: 'src/util.ts', content: '' }, 0, 0);
    expect(entry).toBeGreaterThan(plain);
  });

  it('gives a root-level doc a bigger bonus than a nested one', () => {
    const root = scoreFile({ path: 'README.md', content: '' }, 0, 0);
    const nested = scoreFile({ path: 'docs/guide.md', content: '' }, 0, 0);
    expect(root).toBeGreaterThan(nested);
  });

  it('caps the import-count contribution', () => {
    const capped = scoreFile({ path: 'src/util.ts', content: '' }, 1000, 0);
    const atCap = scoreFile({ path: 'src/util.ts', content: '' }, 10, 0);
    expect(capped).toBe(atCap);
  });
});

describe('rankFiles', () => {
  it('ranks an entry point and a heavily-imported file above an unremarkable one', () => {
    const files: RankableFile[] = [
      { path: 'src/leaf.ts', content: 'export const x = 1;' },
      { path: 'src/main.ts', content: `import { y } from './widely-used';` },
      { path: 'src/widely-used.ts', content: 'export const y = 1;' },
      { path: 'src/other.ts', content: `import { y } from './widely-used';` },
    ];
    const ranked = rankFiles(files, 4);
    expect(ranked[0]).toBe('src/main.ts');
    expect(ranked).not.toContain(undefined);
    expect(ranked.indexOf('src/leaf.ts')).toBeGreaterThan(
      ranked.indexOf('src/widely-used.ts'),
    );
  });

  it('respects the limit', () => {
    const files: RankableFile[] = Array.from({ length: 10 }, (_, i) => ({
      path: `src/f${i}.ts`,
      content: '',
    }));
    expect(rankFiles(files, 3)).toHaveLength(3);
  });
});
