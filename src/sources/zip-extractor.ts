import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import * as yauzl from 'yauzl';
import { resolveInside } from '../common/paths';
import { assertSafeZipEntryPath, ZipSlipError } from './zip-path-guard';

export class ZipBombError extends Error {}
export class ZipSymlinkError extends Error {}

interface ExtractLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

// "100 MB is generous" for the upload itself (per the phase doc); these guard
// what that upload is allowed to expand into once decompressed, which a
// compression ratio can inflate by orders of magnitude.
const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxEntries: 20_000,
  maxEntryBytes: 200 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
};

// External file attributes only carry POSIX mode bits when the archive was
// produced on Unix (`versionMadeBy`'s high byte === 3, the host-system field);
// that's where the S_IFLNK type bits live. A symlink entry's "content" is a
// link-target string, and following it on extraction would let a crafted
// archive write through a path it doesn't itself declare.
function isSymlinkEntry(entry: yauzl.Entry): boolean {
  const hostOS = entry.versionMadeBy >> 8;
  if (hostOS !== 3) return false;
  const unixMode = entry.externalFileAttributes >>> 16;
  return (unixMode & 0xf000) === 0xa000;
}

/**
 * Streams a zip's entries one at a time (never loading the whole archive into
 * memory) into `destRoot`, applying the phase 6 zip-slip checklist to every
 * entry before it touches disk: reject absolute paths, reject `..` segments,
 * resolve-and-verify against the workspace root, reject symlinks, enforce
 * per-entry/total/entry-count caps. Any rejection aborts the whole extraction
 * rather than leaving a partially-populated workspace from a hostile archive.
 */
// yauzl's own entry parser already rejects an absolute or `..`-bearing
// fileName before ever emitting the entry (see its `validateFileName`) — but
// as a fatal parse-level error with an undocumented message shape, not a
// typed error we control. Normalizing that into our own ZipSlipError gives
// callers one stable contract regardless of which layer actually caught it,
// while `assertSafeZipEntryPath`/`resolveInside` below remain the explicit,
// audited, unit-tested defense this project owns for every entry that
// reaches the loop — not a reliance on an upstream library's incidental
// behavior, which is exactly the phase doc's point about routing every
// filesystem boundary through one helper rather than trusting the parser.
const YAUZL_PATH_REJECTION_RE =
  /^(absolute path|invalid relative path|invalid characters in fileName):/;

export async function extractZipSafely(
  zipPath: string,
  destRoot: string,
  limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS,
): Promise<void> {
  await mkdir(destRoot, { recursive: true });

  const zipfile = await yauzl.openPromise(zipPath, {
    lazyEntries: true,
    autoClose: false,
  });
  let entryCount = 0;
  let totalBytes = 0;

  try {
    for await (const entry of zipfile.eachEntry()) {
      entryCount++;
      if (entryCount > limits.maxEntries) {
        throw new ZipBombError(
          `Zip contains more than ${limits.maxEntries} entries`,
        );
      }

      assertSafeZipEntryPath(entry.fileName);
      const destPath = resolveInside(destRoot, entry.fileName);

      if (isSymlinkEntry(entry)) {
        throw new ZipSymlinkError(
          `Symlink entries are rejected: ${entry.fileName}`,
        );
      }

      if (entry.fileName.endsWith('/')) {
        await mkdir(destPath, { recursive: true });
        continue;
      }

      if (entry.uncompressedSize > limits.maxEntryBytes) {
        throw new ZipBombError(
          `Entry exceeds the per-file size cap: ${entry.fileName}`,
        );
      }
      if (totalBytes + entry.uncompressedSize > limits.maxTotalBytes) {
        throw new ZipBombError('Zip exceeds the total uncompressed size cap');
      }

      await mkdir(path.dirname(destPath), { recursive: true });
      totalBytes += await writeEntryCapped(
        zipfile,
        entry,
        destPath,
        limits,
        totalBytes,
      );
    }
  } catch (err) {
    if (err instanceof Error && YAUZL_PATH_REJECTION_RE.test(err.message)) {
      throw new ZipSlipError(err.message);
    }
    throw err;
  } finally {
    zipfile.close();
  }
}

// Declared sizes come from the archive's own central directory, which a
// hostile zip fully controls — real enforcement is counting bytes as they
// actually stream off the decompressor, not trusting what the entry claims.
function writeEntryCapped(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  destPath: string,
  limits: ExtractLimits,
  bytesSoFar: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let written = 0;
    let settled = false;

    zipfile.openReadStream(entry, (err, readStream) => {
      if (err) {
        reject(err);
        return;
      }

      const writeStream = createWriteStream(destPath);
      const fail = (failure: Error) => {
        if (settled) return;
        settled = true;
        readStream.destroy();
        writeStream.destroy();
        reject(failure);
      };

      readStream.on('data', (chunk: Buffer) => {
        written += chunk.length;
        if (
          written > limits.maxEntryBytes ||
          bytesSoFar + written > limits.maxTotalBytes
        ) {
          fail(
            new ZipBombError(
              `Entry exceeds the size cap while extracting: ${entry.fileName}`,
            ),
          );
        }
      });
      readStream.on('error', fail);
      writeStream.on('error', fail);
      writeStream.on('finish', () => {
        if (settled) return;
        settled = true;
        resolve(written);
      });
      readStream.pipe(writeStream);
    });
  });
}
