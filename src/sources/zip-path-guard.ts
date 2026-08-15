// PURE — no I/O. The first, cheap layer of the zip-slip defence: reject an
// entry name on its shape alone, before any path resolution happens.
// `resolveInside` (common/paths.ts) is the second, load-bearing layer applied
// afterward — this guard exists to give a precise, entry-specific error and
// to reject the input before it is ever handed to `path.resolve` at all.
export class ZipSlipError extends Error {}

const DRIVE_LETTER_RE = /^[A-Za-z]:/;

export function assertSafeZipEntryPath(entryName: string): void {
  const normalized = entryName.replace(/\\/g, '/');

  if (normalized.startsWith('/') || DRIVE_LETTER_RE.test(normalized)) {
    throw new ZipSlipError(`Absolute path entry rejected: ${entryName}`);
  }

  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new ZipSlipError(`Path traversal entry rejected: ${entryName}`);
  }
}
