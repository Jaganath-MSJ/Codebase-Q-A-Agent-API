import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import { ZipSlipError } from './zip-path-guard';
import {
  extractZipSafely,
  ZipBombError,
  ZipSymlinkError,
} from './zip-extractor';

interface ZipEntrySpec {
  path: string;
  content?: string;
  mode?: number;
  directory?: boolean;
}

// Crafts a real zip in-memory with yazl — the attack, written before the
// defence, per the phase doc's own instruction to build the malicious
// archive first and watch it (fail to) escape.
function buildZip(entries: ZipEntrySpec[]): Promise<Buffer> {
  const zip = new ZipFile();
  for (const entry of entries) {
    if (entry.directory) {
      zip.addEmptyDirectory(entry.path, { mode: entry.mode });
    } else {
      zip.addBuffer(Buffer.from(entry.content ?? ''), entry.path, {
        mode: entry.mode,
      });
    }
  }
  zip.end();

  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}

function needsPlaceholder(entryPath: string): boolean {
  const normalized = entryPath.replace(/\\/g, '/');
  return (
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split('/').includes('..')
  );
}

function craftPlaceholder(length: number, seed: string): string {
  const marker = `~${seed}~`;
  let out = '';
  while (out.length < length) out += marker;
  return out.slice(0, length);
}

/**
 * yazl itself validates every metadataPath and refuses the exact shapes this
 * test needs to attack (absolute paths, `..` segments) — the same shapes
 * `assertSafeZipEntryPath`/`resolveInside` exist to reject. So the archive is
 * built with a same-length placeholder name, then the raw zip bytes are
 * patched afterward: the zip format stores each file name as a literal byte
 * run with no other offset depending on its content, so an exact-length
 * in-place substitution yields a structurally valid zip carrying an
 * attacker-controlled name — precisely what a hand-crafted malicious archive
 * would contain, built here rather than by hand per the phase doc's "write
 * the attack before the defence."
 */
async function buildMaliciousZip(entries: ZipEntrySpec[]): Promise<Buffer> {
  const substitutions: Array<{ placeholder: string; real: string }> = [];
  const safeEntries = entries.map((entry, i) => {
    if (!needsPlaceholder(entry.path)) return entry;
    const placeholder = craftPlaceholder(entry.path.length, `P${i}`);
    substitutions.push({ placeholder, real: entry.path });
    return { ...entry, path: placeholder };
  });

  let buf = await buildZip(safeEntries);
  for (const { placeholder, real } of substitutions) {
    buf = Buffer.from(
      buf.toString('binary').split(placeholder).join(real),
      'binary',
    );
  }
  return buf;
}

const S_IFLNK = 0o120000;

let workDir: string;

async function tempDirs() {
  workDir = await mkdtemp(path.join(tmpdir(), 'zip-extractor-spec-'));
  const zipPath = path.join(workDir, 'archive.zip');
  const destRoot = path.join(workDir, 'workspace');
  return { zipPath, destRoot };
}

afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe('extractZipSafely', () => {
  it('rejects a POSIX-style path-traversal entry, and writes nothing outside the root', async () => {
    const { zipPath, destRoot } = await tempDirs();
    await writeFile(
      zipPath,
      await buildMaliciousZip([{ path: '../../evil.txt', content: 'pwned' }]),
    );

    await expect(extractZipSafely(zipPath, destRoot)).rejects.toThrow(
      ZipSlipError,
    );
    await expect(
      readFile(path.join(workDir, 'evil.txt'), 'utf8'),
    ).rejects.toThrow();
  });

  it('rejects a Windows-style backslash path-traversal entry', async () => {
    const { zipPath, destRoot } = await tempDirs();
    await writeFile(
      zipPath,
      await buildMaliciousZip([{ path: '..\\..\\evil.txt', content: 'pwned' }]),
    );

    await expect(extractZipSafely(zipPath, destRoot)).rejects.toThrow(
      ZipSlipError,
    );
    await expect(
      readFile(path.join(workDir, 'evil.txt'), 'utf8'),
    ).rejects.toThrow();
  });

  it('rejects an absolute path entry', async () => {
    const { zipPath, destRoot } = await tempDirs();
    await writeFile(
      zipPath,
      await buildMaliciousZip([{ path: '/etc/passwd', content: 'pwned' }]),
    );

    await expect(extractZipSafely(zipPath, destRoot)).rejects.toThrow(
      ZipSlipError,
    );
  });

  it('rejects a symlink entry', async () => {
    const { zipPath, destRoot } = await tempDirs();
    await writeFile(
      zipPath,
      await buildZip([
        { path: 'innocuous-link', content: '/etc', mode: S_IFLNK | 0o777 },
      ]),
    );

    await expect(extractZipSafely(zipPath, destRoot)).rejects.toThrow(
      ZipSymlinkError,
    );
  });

  it('rejects a zip with more entries than the configured cap', async () => {
    const { zipPath, destRoot } = await tempDirs();
    const entries = Array.from({ length: 5 }, (_, i) => ({
      path: `file-${i}.txt`,
      content: 'x',
    }));
    await writeFile(zipPath, await buildZip(entries));

    await expect(
      extractZipSafely(zipPath, destRoot, {
        maxEntries: 3,
        maxEntryBytes: 1_000,
        maxTotalBytes: 10_000,
      }),
    ).rejects.toThrow(ZipBombError);
  });

  it('rejects an entry whose declared size exceeds the per-entry cap', async () => {
    const { zipPath, destRoot } = await tempDirs();
    await writeFile(
      zipPath,
      await buildZip([{ path: 'big.txt', content: 'x'.repeat(1_000) }]),
    );

    await expect(
      extractZipSafely(zipPath, destRoot, {
        maxEntries: 10,
        maxEntryBytes: 100,
        maxTotalBytes: 10_000,
      }),
    ).rejects.toThrow(ZipBombError);
  });

  it('rejects a zip whose total uncompressed size exceeds the total cap', async () => {
    const { zipPath, destRoot } = await tempDirs();
    await writeFile(
      zipPath,
      await buildZip([
        { path: 'a.txt', content: 'x'.repeat(80) },
        { path: 'b.txt', content: 'x'.repeat(80) },
      ]),
    );

    await expect(
      extractZipSafely(zipPath, destRoot, {
        maxEntries: 10,
        maxEntryBytes: 100,
        maxTotalBytes: 100,
      }),
    ).rejects.toThrow(ZipBombError);
  });

  it('extracts a legitimate zip with nested directories exactly as archived', async () => {
    const { zipPath, destRoot } = await tempDirs();
    await writeFile(
      zipPath,
      await buildZip([
        { path: 'src/', directory: true },
        { path: 'src/index.ts', content: 'export const x = 1;\n' },
        { path: 'README.md', content: '# hello\n' },
      ]),
    );

    await extractZipSafely(zipPath, destRoot);

    expect(await readFile(path.join(destRoot, 'src', 'index.ts'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
    expect(await readFile(path.join(destRoot, 'README.md'), 'utf8')).toBe(
      '# hello\n',
    );
  });
});
