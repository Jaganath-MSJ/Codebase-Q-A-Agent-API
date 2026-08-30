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
  return text.length > MAX_EMBED_TEXT_CHARS ? text.slice(0, MAX_EMBED_TEXT_CHARS) : text;
}

// transformers.js pads every sequence in a batch to the longest sequence in
// that same batch before running inference, and attention cost is quadratic
// in that padded length — so a batch's peak memory is driven by its longest
// member, not its average. Real chunk lengths vary enough that a batch of 32
// commonly contains at least one chunk near the 2048-token ceiling above,
// which then forces all 32 to pay that chunk's full quadratic cost. Root-
// caused via isolated reproduction (see docs/PROGRESS.md): a single
// near-ceiling chunk alone peaks around 577 MB RSS, but a same-length batch
// of 32 extrapolates to the ~14 GB spikes actually observed on an 8 GB
// machine. Measured worst case (4 real chunks, each truncated to the 2048-
// token ceiling) peaks at ~1.46 GB — a batch of 32 at that same worst case
// would be roughly 8x that. 4 keeps worst-case peak memory well within an
// 8 GB machine's budget; it costs throughput (more, smaller requests) but
// nothing else, since the per-day request budget (900) has ample headroom.
const MAX_BATCH_SIZE = 4;

@Injectable()
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly id = `local:${MODEL_ID}`;
  readonly dimensions = 768 as const;
  readonly maxBatchSize = MAX_BATCH_SIZE;

  private pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

  constructor(config: ConfigService) {
    env.cacheDir = path.join(config.dataDir, 'models');
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embed(texts.map((text) => `search_document: ${text}`));
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embed([`search_query: ${text}`]);
    if (!vector) throw new Error('Embedding pipeline returned no output for query');
    return vector;
  }

  private async getPipeline(): Promise<FeatureExtractionPipeline> {
    this.pipelinePromise ??= pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
    return this.pipelinePromise;
  }

  private async embed(prefixed: string[]): Promise<number[][]> {
    const extractor = await this.getPipeline();
    const output = await extractor(prefixed.map(truncateForEmbedding), { pooling: 'mean', normalize: true });
    return output.tolist() as number[][];
  }
}
