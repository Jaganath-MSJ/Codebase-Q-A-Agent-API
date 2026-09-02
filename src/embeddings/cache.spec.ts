import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CachingEmbeddingProvider } from './cache';
import type { EmbeddingProvider } from './embedding-provider.interface';

const DIM = 768;
const validVector = (seed = 0.1) => Array.from({ length: DIM }, () => seed);

/** Records what texts reach the model, so a cache HIT vs MISS is observable. */
class FakeProvider implements EmbeddingProvider {
  readonly id = 'local:test-model';
  readonly dimensions = DIM as const;
  readonly maxBatchSize = 4;
  readonly seen: string[][] = [];
  constructor(private readonly reply: (texts: string[]) => number[][]) {}
  async embedDocuments(texts: string[]): Promise<number[][]> {
    this.seen.push(texts);
    return this.reply(texts);
  }
  async embedQuery(text: string): Promise<number[]> {
    this.seen.push([text]);
    return this.reply([text])[0]!;
  }
}

describe('CachingEmbeddingProvider corrupt-cache handling', () => {
  let root: string;
  let modelDir: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'emb-cache-'));
    // Mirrors CachingEmbeddingProvider's id sanitization.
    modelDir = path.join(root, 'local_test-model');
    await mkdir(modelDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const binFiles = async () => (await readdir(modelDir)).filter((f) => f.endsWith('.bin'));

  it('treats a 0-byte cache file as a miss, re-embeds, and heals it', async () => {
    // Poison: write a 0-byte file at the exact path the provider would read.
    const inner = new FakeProvider(() => [validVector(0.5)]);
    const provider = new CachingEmbeddingProvider(inner, root);
    // Reach into the same hashing the provider uses by pre-seeding a cache
    // file for a known text, then truncating it to zero bytes.
    await provider.embedDocuments(['hello world']); // writes a valid file
    const [file] = await binFiles();
    await writeFile(path.join(modelDir, file!), Buffer.alloc(0)); // corrupt it

    inner.seen.length = 0;
    const out = await provider.embedDocuments(['hello world']);

    expect(out[0]).toHaveLength(DIM); // got a real vector, not []
    expect(inner.seen).toHaveLength(1); // corrupt file forced a re-embed (miss)
    // The corrupt file is replaced with a valid 3072-byte one.
    expect(existsSync(path.join(modelDir, file!))).toBe(true);
  });

  it('never persists a malformed (wrong-length) vector', async () => {
    const inner = new FakeProvider(() => [[]]); // model emits a 0-dim vector
    const provider = new CachingEmbeddingProvider(inner, root);

    const out = await provider.embedDocuments(['boom']);

    // The bad vector still flows through so the indexer can fail/retry loudly...
    expect(out[0]).toHaveLength(0);
    // ...but it must not be written to disk as a poisoned cache entry.
    expect(await binFiles()).toHaveLength(0);
  });

  it('caches and returns a valid vector on the happy path', async () => {
    const inner = new FakeProvider(() => [validVector(0.25)]);
    const provider = new CachingEmbeddingProvider(inner, root);

    const first = await provider.embedDocuments(['keep me']);
    inner.seen.length = 0;
    const second = await provider.embedDocuments(['keep me']);

    expect(first[0]).toHaveLength(DIM);
    expect(second[0]).toEqual(first[0]);
    expect(inner.seen).toHaveLength(0); // second call was a pure cache hit
  });
});
