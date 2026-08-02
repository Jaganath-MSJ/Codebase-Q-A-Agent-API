import { Injectable } from '@nestjs/common';
import { pipeline, env } from '@huggingface/transformers';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import * as path from 'node:path';
import { ConfigService } from '../../config/config.service';
import type { EmbeddingProvider } from '../embedding-provider.interface';

const MODEL_ID = 'nomic-ai/nomic-embed-text-v1.5';

@Injectable()
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly id = `local:${MODEL_ID}`;
  readonly dimensions = 768 as const;
  readonly maxBatchSize = 32;

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
    const output = await extractor(prefixed, { pooling: 'mean', normalize: true });
    return output.tolist() as number[][];
  }
}
