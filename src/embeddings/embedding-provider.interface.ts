export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: 768;
  readonly maxBatchSize: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}
