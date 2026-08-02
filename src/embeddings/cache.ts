import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
    try {
      const buf = await readFile(this.cachePath(text));
      const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      return Array.from(floats);
    } catch {
      return undefined;
    }
  }

  private async writeCache(text: string, vector: number[]): Promise<void> {
    const target = this.cachePath(text);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(new Float32Array(vector).buffer));
  }
}
