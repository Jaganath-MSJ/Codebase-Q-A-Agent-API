import { describe, expect, it } from 'vitest';
import { hasAllowedExtension, isDenylisted } from './filters';

describe('isDenylisted', () => {
  it('rejects paths under denylisted prefixes', () => {
    expect(isDenylisted('.git/config')).toBe(true);
    expect(isDenylisted('node_modules/pkg/index.js')).toBe(true);
    expect(isDenylisted('dist/main.js')).toBe(true);
  });

  it('allows everything else', () => {
    expect(isDenylisted('src/index.ts')).toBe(false);
    expect(isDenylisted('README.md')).toBe(false);
  });
});

describe('hasAllowedExtension', () => {
  it('allows recognized source/docs/config extensions', () => {
    expect(hasAllowedExtension('src/index.ts')).toBe(true);
    expect(hasAllowedExtension('README.md')).toBe(true);
    expect(hasAllowedExtension('package.json')).toBe(true);
  });

  it('rejects files with no extension or unrecognized extensions', () => {
    expect(hasAllowedExtension('Makefile')).toBe(false);
    expect(hasAllowedExtension('vendor/generated.min.js')).toBe(true); // .js allowed by extension
    expect(hasAllowedExtension('bin/tool')).toBe(false);
  });
});
