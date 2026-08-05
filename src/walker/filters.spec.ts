import { describe, expect, it } from 'vitest';
import {
  classifyExtension,
  hasAllowedExtension,
  hasExcessiveLineLength,
  isDenylisted,
  isFilenameDenylisted,
} from './filters';

describe('isDenylisted', () => {
  it('rejects paths under denylisted prefixes', () => {
    expect(isDenylisted('.git/config')).toBe(true);
    expect(isDenylisted('node_modules/pkg/index.js')).toBe(true);
    expect(isDenylisted('dist/main.js')).toBe(true);
    expect(isDenylisted('vendor/lib.rb')).toBe(true);
    expect(isDenylisted('__pycache__/mod.pyc')).toBe(true);
  });

  it('allows everything else', () => {
    expect(isDenylisted('src/index.ts')).toBe(false);
    expect(isDenylisted('README.md')).toBe(false);
  });
});

describe('classifyExtension / hasAllowedExtension', () => {
  it('allows recognized source/docs/config extensions', () => {
    expect(hasAllowedExtension('src/index.ts')).toBe(true);
    expect(hasAllowedExtension('README.md')).toBe(true);
    expect(hasAllowedExtension('package.json')).toBe(true);
  });

  it('classifies unrecognized extensions as denied', () => {
    expect(classifyExtension('image.png')).toBe('denied');
    expect(classifyExtension('bin/tool.exe')).toBe('denied');
  });

  it('classifies extensionless files as unknown, not denied', () => {
    expect(classifyExtension('Makefile')).toBe('unknown');
    expect(classifyExtension('Dockerfile')).toBe('unknown');
  });
});

describe('isFilenameDenylisted', () => {
  it('rejects known lockfiles regardless of directory', () => {
    expect(isFilenameDenylisted('package-lock.json')).toBe(true);
    expect(isFilenameDenylisted('web/yarn.lock')).toBe(true);
    expect(isFilenameDenylisted('pnpm-lock.yaml')).toBe(true);
  });

  it('rejects generated/minified/map/snapshot patterns', () => {
    expect(isFilenameDenylisted('dist/app.min.js')).toBe(true);
    expect(isFilenameDenylisted('dist/app.js.map')).toBe(true);
    expect(isFilenameDenylisted('__snapshots__/a.snap')).toBe(true);
    expect(isFilenameDenylisted('src/schema.generated.ts')).toBe(true);
  });

  it('allows ordinary source files', () => {
    expect(isFilenameDenylisted('src/index.ts')).toBe(false);
    expect(isFilenameDenylisted('package.json')).toBe(false);
  });
});

describe('hasExcessiveLineLength', () => {
  it('flags a single line over the limit', () => {
    expect(hasExcessiveLineLength('x'.repeat(2001))).toBe(true);
  });

  it('allows normal multi-line text', () => {
    expect(hasExcessiveLineLength('short\nlines\nhere')).toBe(false);
  });

  it('checks each line independently, not the total length', () => {
    const manyShortLines = Array.from({ length: 2000 }, () => 'x').join('\n');
    expect(hasExcessiveLineLength(manyShortLines)).toBe(false);
  });

  it('respects a custom max length', () => {
    expect(hasExcessiveLineLength('12345', 3)).toBe(true);
    expect(hasExcessiveLineLength('123', 3)).toBe(false);
  });
});
