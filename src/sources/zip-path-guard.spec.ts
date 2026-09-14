import { describe, expect, it } from 'vitest';
import { assertSafeZipEntryPath, ZipSlipError } from './zip-path-guard';

describe('assertSafeZipEntryPath', () => {
  const rejected = [
    '../../evil.txt',
    '..\\..\\evil.txt',
    '/etc/passwd',
    '\\windows\\system32\\evil.txt',
    'C:\\evil.txt',
    'C:evil.txt',
    'd:/evil.txt',
    'foo/../../bar.txt',
    'a/b/../../../c.txt',
    '..',
    'a/..',
  ];

  it.each(rejected)('rejects %s', (entryName) => {
    expect(() => assertSafeZipEntryPath(entryName)).toThrow(ZipSlipError);
  });

  const accepted = [
    'src/index.ts',
    'a/b/c.txt',
    'README.md',
    'a/b/',
    '..hidden/file.txt',
    'a..b/c',
  ];

  it.each(accepted)('accepts %s', (entryName) => {
    expect(() => assertSafeZipEntryPath(entryName)).not.toThrow();
  });
});
