import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isValidUploadId, resolveUploadPath } from './upload-id';

describe('isValidUploadId', () => {
  it('accepts a real randomUUID()-shaped id', () => {
    expect(isValidUploadId('0e683580-8cce-41e7-864f-709d322bd4f4')).toBe(true);
  });

  const rejected = [
    '../../etc/passwd',
    '..\\..\\etc\\passwd',
    '/etc/passwd',
    'C:/Windows/win.ini',
    'not-a-uuid',
    '',
    '0e683580-8cce-41e7-864f-709d322bd4f4/../../evil',
    '0e683580-8cce-41e7-864f-709d322bd4f4.zip',
  ];

  it.each(rejected)('rejects %s', (candidate) => {
    expect(isValidUploadId(candidate)).toBe(false);
  });
});

describe('resolveUploadPath', () => {
  const uploadsDir = path.resolve('D:/fake/data/uploads');

  it('resolves a valid uploadId under uploadsDir', () => {
    const uploadId = '0e683580-8cce-41e7-864f-709d322bd4f4';
    expect(resolveUploadPath(uploadsDir, uploadId)).toBe(
      path.join(uploadsDir, `${uploadId}.zip`),
    );
  });

  it('rejects a path-traversal uploadId before ever calling path.resolve on it', () => {
    expect(() => resolveUploadPath(uploadsDir, '../../etc/passwd')).toThrow(
      /Not a valid uploadId/,
    );
  });

  it('rejects an absolute-path uploadId', () => {
    expect(() => resolveUploadPath(uploadsDir, '/etc/passwd')).toThrow(
      /Not a valid uploadId/,
    );
  });
});
