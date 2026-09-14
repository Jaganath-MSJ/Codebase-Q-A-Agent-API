import { describe, expect, it } from 'vitest';
import {
  detectFrameworks,
  firstParagraph,
  mostCommonLanguage,
  renderOverviewDigest,
  topLevelDirCounts,
  type OverviewFileEntry,
} from './overview-digest';

describe('mostCommonLanguage', () => {
  it('picks the extension with the most files, ignoring unmapped extensions', () => {
    const files: OverviewFileEntry[] = [
      { relPath: 'a.ts', lang: 'ts' },
      { relPath: 'b.ts', lang: 'ts' },
      { relPath: 'c.py', lang: 'py' },
      { relPath: 'd.json', lang: 'json' },
    ];
    expect(mostCommonLanguage(files)).toBe('TypeScript');
  });

  it('returns null when nothing matches a known language', () => {
    expect(
      mostCommonLanguage([{ relPath: 'a.json', lang: 'json' }]),
    ).toBeNull();
  });
});

describe('topLevelDirCounts', () => {
  it('groups files by up to two path segments and skips root-level files', () => {
    const files: OverviewFileEntry[] = [
      { relPath: 'src/indexing/a.ts', lang: 'ts' },
      { relPath: 'src/indexing/b.ts', lang: 'ts' },
      { relPath: 'src/chat.ts', lang: 'ts' },
      { relPath: 'README.md', lang: 'md' },
    ];
    expect(topLevelDirCounts(files, 5)).toEqual([
      { dir: 'src/indexing', count: 2 },
      { dir: 'src', count: 1 },
    ]);
  });

  it('caps results at the given limit', () => {
    const files: OverviewFileEntry[] = [
      { relPath: 'a/x.ts', lang: 'ts' },
      { relPath: 'b/x.ts', lang: 'ts' },
      { relPath: 'c/x.ts', lang: 'ts' },
    ];
    expect(topLevelDirCounts(files, 2)).toHaveLength(2);
  });
});

describe('detectFrameworks', () => {
  it('extracts a major version from a semver range', () => {
    expect(detectFrameworks({ '@nestjs/core': '^11.0.2' })).toEqual([
      'NestJS 11',
    ]);
  });

  it('omits the version when it cannot be parsed', () => {
    expect(detectFrameworks({ react: 'latest' })).toEqual(['React']);
  });

  it('never lists a label twice, even if two aliases both match', () => {
    expect(
      detectFrameworks({ react: '^19.0.0', 'react-dom': '^19.0.0' }),
    ).toEqual(['React 19']);
  });

  it('ignores dependencies with no known framework label', () => {
    expect(detectFrameworks({ lodash: '^4.0.0' })).toEqual([]);
  });
});

describe('firstParagraph', () => {
  it('drops a leading H1 and returns the next paragraph', () => {
    const md =
      "# Tiny Repo\n\nA small fixture repository.\n\n## What's here\n\n- item";
    expect(firstParagraph(md)).toBe('A small fixture repository.');
  });

  it('collapses internal whitespace and line breaks', () => {
    expect(firstParagraph('Line one\nline two.')).toBe('Line one line two.');
  });

  it('returns null for an empty document', () => {
    expect(firstParagraph('')).toBeNull();
  });

  it('truncates long paragraphs', () => {
    const long = 'a'.repeat(600);
    const result = firstParagraph(long);
    expect(result).toHaveLength(501);
    expect(result?.endsWith('…')).toBe(true);
  });
});

describe('renderOverviewDigest', () => {
  it("matches the phase doc's rendered example shape", () => {
    const digest = renderOverviewDigest({
      name: 'codebase-qa-agent',
      totalFiles: 412,
      topLanguage: 'TypeScript',
      topDirs: [
        { dir: 'src/indexing', count: 48 },
        { dir: 'src/retrieval', count: 31 },
      ],
      frameworks: ['NestJS 11', 'React 19'],
      scripts: ['dev', 'build', 'test', 'eval'],
      readmeExcerpt: null,
    });
    expect(digest).toBe(
      'codebase-qa-agent — TypeScript. 412 files.\n' +
        'Top dirs: src/indexing (48), src/retrieval (31).\n' +
        'Detected: NestJS 11, React 19.\n' +
        'Scripts: dev, build, test, eval.',
    );
  });

  it('omits empty sections and appends the README excerpt last', () => {
    const digest = renderOverviewDigest({
      name: 'tiny-repo',
      totalFiles: 3,
      topLanguage: null,
      topDirs: [],
      frameworks: [],
      scripts: [],
      readmeExcerpt: 'A small fixture repository.',
    });
    expect(digest).toBe('tiny-repo. 3 files.\n\nA small fixture repository.');
  });
});
