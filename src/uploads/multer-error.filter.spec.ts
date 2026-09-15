import { describe, it, expect, vi } from 'vitest';
import { MulterError } from 'multer';
import type { ArgumentsHost } from '@nestjs/common';
import { MulterErrorFilter } from './multer-error.filter';

/**
 * QA pass — TC-UPL-*.
 *
 * Multer rejects an oversized upload inside the interceptor, before the
 * controller method runs, so without this filter the user gets a bare 500 for
 * what is plainly their mistake. The filter's whole job is turning that into a
 * 400 with a message worth reading.
 */

function fakeHost() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('MulterErrorFilter', () => {
  const filter = new MulterErrorFilter();

  it('TC-UPL-001 maps LIMIT_FILE_SIZE to 400 with the size-cap message', () => {
    const { host, status, json } = fakeHost();

    filter.catch(new MulterError('LIMIT_FILE_SIZE'), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Upload exceeds the 100 MB size cap',
      }),
    );
  });

  it('TC-UPL-002 maps any other multer error to 400 using its own message', () => {
    const { host, status, json } = fakeHost();

    filter.catch(new MulterError('LIMIT_UNEXPECTED_FILE', 'archive'), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400 }),
    );
    const body = json.mock.calls[0]![0] as { message: string };
    expect(body.message).not.toBe('Upload exceeds the 100 MB size cap');
    expect(body.message.length).toBeGreaterThan(0);
  });

  it('TC-UPL-003 never responds with 500 for any multer error code', () => {
    const codes = [
      'LIMIT_PART_COUNT',
      'LIMIT_FILE_SIZE',
      'LIMIT_FILE_COUNT',
      'LIMIT_FIELD_KEY',
      'LIMIT_FIELD_VALUE',
      'LIMIT_FIELD_COUNT',
      'LIMIT_UNEXPECTED_FILE',
    ] as const;

    for (const code of codes) {
      const { host, status } = fakeHost();
      filter.catch(new MulterError(code), host);
      expect(status, `code ${code}`).toHaveBeenCalledWith(400);
    }
  });

  it('TC-UPL-004 does not leak a filesystem path in the size-cap message (SEC)', () => {
    const { host, json } = fakeHost();

    filter.catch(
      new MulterError('LIMIT_FILE_SIZE', '/var/tmp/upload-xyz'),
      host,
    );

    const body = json.mock.calls[0]![0] as { message: string };
    expect(body.message).toBe('Upload exceeds the 100 MB size cap');
    expect(body.message).not.toContain('/var/tmp');
  });

  it('TC-UPL-005 states the cap as a number the user can act on', () => {
    const { host, json } = fakeHost();
    filter.catch(new MulterError('LIMIT_FILE_SIZE'), host);
    const body = json.mock.calls[0]![0] as { message: string };
    expect(body.message).toMatch(/100 MB/);
  });
});
