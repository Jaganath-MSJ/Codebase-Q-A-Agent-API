import { Injectable } from '@nestjs/common';
import { pipeline, env } from '@huggingface/transformers';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import * as path from 'node:path';
import { ConfigService } from '../../config/config.service';
import type { EmbeddingProvider } from '../embedding-provider.interface';

const MODEL_ID = 'nomic-ai/nomic-embed-text-v1.5';

// This ONNX export's *real* context limit is config.json's max_position_embeddings
// (2048), not tokenizer_config.json's model_max_length (8192) — transformers.js's
// feature-extraction pipeline truncates against the latter (the tokenizer default)
// with no way to override max_length through its public options, so a chunk over
// ~2048 tokens reaches the model uncapped. Observed consequences on real
// repositories: an ONNX buffer-allocation failure requesting ~27 GB for one batch,
// and separately a malformed 0-dimensional pooled output — both silent/cryptic
// instead of a clean error. A conservative character cap (empirically verified
// against the worst real chunks that triggered this: the densest ~12,000-character
// chunk tokenizes to ~3,234 tokens, so 4,500 characters leaves comfortable margin
// under 2048 even for dense, low-whitespace content) avoids needing to reimplement
// the pipeline's internal tokenization/pooling just to pass one extra option.
const MAX_EMBED_TEXT_CHARS = 4500;

export function truncateForEmbedding(text: string): string {
  return text.length > MAX_EMBED_TEXT_CHARS
    ? text.slice(0, MAX_EMBED_TEXT_CHARS)
    : text;
}

// transformers.js pads every sequence in a batch to the longest sequence in
// that same batch before running inference, and attention cost is quadratic in
// that padded length — so a batch's peak memory is driven by its longest member
// (~ count * maxLen^2), not its average. Root-caused via isolated reproduction
// (see docs/PROGRESS.md): a single near-ceiling chunk alone peaks ~577 MB RSS;
// the measured worst case of 4 chunks each at the character ceiling peaks
// ~1.46 GB, while a flat batch of 32 at that same worst case extrapolates to the
// ~14 GB spikes that OOM an 8 GB machine.
//
// Instead of a flat batch of 4, the indexer hands us up to
// MAX_OUTER_BATCH chunks and we split them into length-bucketed sub-batches
// whose padded cost (count * maxLen^2) never exceeds that proven-safe flat-4-at-
// ceiling budget. Short chunks — the common case — pack dozens per sub-batch
// (far fewer, larger inferences → higher throughput), while a near-ceiling chunk
// is isolated, so peak memory stays where the flat-4 design already proved safe.
const MAX_OUTER_BATCH = 64;
export const EMBED_CHAR_CEILING = MAX_EMBED_TEXT_CHARS;
export const SUBBATCH_PADDED_BUDGET =
  4 * MAX_EMBED_TEXT_CHARS * MAX_EMBED_TEXT_CHARS;

/**
 * Group indices into memory-safe sub-batches. Sorted by length so each batch's
 * members are similar, then greedily filled while `count * maxLen^2` stays within
 * SUBBATCH_PADDED_BUDGET (a single chunk always fits — at the char ceiling its
 * cost is 1/4 of the budget). Returns index groups; the caller places results
 * back into input order. Pure — no I/O.
 */
export function planLengthBucketedBatches(lengths: number[]): number[][] {
  const order = [...lengths.keys()].sort((a, b) => lengths[a]! - lengths[b]!);
  const batches: number[][] = [];
  let cur: number[] = [];
  let curMaxLen = 0;
  for (const i of order) {
    const len = Math.max(1, lengths[i]!);
    const candidateMax = Math.max(curMaxLen, len);
    if (
      cur.length > 0 &&
      (cur.length + 1) * candidateMax * candidateMax > SUBBATCH_PADDED_BUDGET
    ) {
      batches.push(cur);
      cur = [];
      curMaxLen = 0;
    }
    cur.push(i);
    curMaxLen = Math.max(curMaxLen, len);
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

@Injectable()
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly id = `local:${MODEL_ID}`;
  readonly dimensions = 768 as const;
  readonly maxBatchSize = MAX_OUTER_BATCH;

  private pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

  constructor(config: ConfigService) {
    env.cacheDir = path.join(config.dataDir, 'models');
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embed(texts.map((text) => `search_document: ${text}`));
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embed([`search_query: ${text}`]);
    if (!vector)
      throw new Error('Embedding pipeline returned no output for query');
    return vector;
  }

  private async getPipeline(): Promise<FeatureExtractionPipeline> {
    this.pipelinePromise ??= pipeline('feature-extraction', MODEL_ID, {
      dtype: 'q8',
    });
    return this.pipelinePromise;
  }

  private async embed(prefixed: string[]): Promise<number[][]> {
    const extractor = await this.getPipeline();
    const texts = prefixed.map(truncateForEmbedding);
    const results = new Array<number[]>(texts.length);
    // Process one length-bucketed sub-batch at a time so peak memory is bounded
    // by the sub-batch budget, not the whole outer batch.
    for (const group of planLengthBucketedBatches(texts.map((t) => t.length))) {
      const output = await extractor(
        group.map((i) => texts[i]!),
        { pooling: 'mean', normalize: true },
      );
      const vectors = output.tolist() as number[][];
      // The observed memory-pressure failure mode is a short/malformed pooled
      // output — turn it into a loud, retryable error here (the indexer re-checks
      // the full batch length and per-vector dimension too).
      if (vectors.length !== group.length) {
        throw new Error(
          `Embedding sub-batch returned ${vectors.length} vectors for ${group.length} inputs`,
        );
      }
      group.forEach((idx, j) => {
        results[idx] = vectors[j]!;
      });
    }
    return results;
  }
}
