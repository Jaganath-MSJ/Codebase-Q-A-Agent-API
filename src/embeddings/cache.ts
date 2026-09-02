import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { sha256 } from '../common/hash';
import type { EmbeddingProvider } from './embedding-provider.interface';

export class CachingEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions = 768 as const;
  readonly maxBatchSize: number;

  private readonly modelCacheDir: string;

  constructor(
    private readonly inner: EmbeddingProvider,
    cacheRoot: string,
  ) {
    this.id = inner.id;
    this.maxBatchSize = inner.maxBatchSize;
    this.modelCacheDir = path.join(cacheRoot, inner.id.replace(/[^a-zA-Z0-9._-]/g, '_'));
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const results = new Array<number[]>(texts.length);
    const missingIndices: number[] = [];
    const missingTexts: string[] = [];

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]!;
      const cached = await this.readCache(text);
      if (cached) {
        results[i] = cached;
      } else {
        missingIndices.push(i);
        missingTexts.push(text);
      }
    }

    if (missingTexts.length > 0) {
      const embedded = await this.inner.embedDocuments(missingTexts);
      for (let j = 0; j < missingIndices.length; j++) {
        const vector = embedded[j]!;
        results[missingIndices[j]!] = vector;
        await this.writeCache(missingTexts[j]!, vector);
      }
    }

    return results;
  }

  async embedQuery(text: string): Promise<number[]> {
    const cached = await this.readCache(text);
    if (cached) return cached;

    const vector = await this.inner.embedQuery(text);
    await this.writeCache(text, vector);
    return vector;
  }

  private cachePath(text: string): string {
    return path.join(this.modelCacheDir, `${sha256(text)}.bin`);
  }

  private async readCache(text: string): Promise<number[] | undefined> {
    const target = this.cachePath(text);
    let buf: Buffer;
    try {
      buf = await readFile(target);
    } catch {
      return undefined;
    }
    // A valid cached vector is exactly `dimensions` float32s. A file that is
    // empty, truncated, or otherwise the wrong size is corrupt — most often a
    // 0-byte file left by a process killed mid-embedding, or one that cached a
    // malformed model output. Treat it as a miss (and delete it) rather than
    // returning a short/empty vector: an empty array is truthy, so returning it
    // would hand the indexer a "0-dimensional vector" that aborts the whole
    // index run, and does so deterministically on every retry until the file is
    // removed. Purging on read lets a poisoned cache self-heal on the next run.
    if (buf.byteLength !== this.dimensions * 4) {
      await rm(target, { force: true }).catch(() => undefined);
      return undefined;
    }
    const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return Array.from(floats);
  }

  private async writeCache(text: string, vector: number[]): Promise<void> {
    // Never persist a malformed vector — caching a wrong-length (e.g. empty)
    // result is exactly what poisons the cache, since readCache would later
    // hand it back as though it were a valid embedding. The indexer still sees
    // the bad vector in the returned batch and fails/retries loudly; we simply
    // refuse to make that failure permanent on disk.
    if (vector.length !== this.dimensions) return;
    const target = this.cachePath(text);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(new Float32Array(vector).buffer));
  }
}
