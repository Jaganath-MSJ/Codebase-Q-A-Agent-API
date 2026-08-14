export interface EmbeddingContext {
  path: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  content: string;
}

/**
 * Prepends a context header (path, symbol, line range) to the text sent to
 * the embedding model — the path and symbol are strong semantic signal the
 * code body alone lacks. Must only ever be used for the embedded text, never
 * written to `chunks.content`: doing so would shift every line number by
 * one and break every citation.
 */
export function buildEmbeddingText(chunk: EmbeddingContext): string {
  const symbolPart = chunk.symbol ? ` (${chunk.symbol})` : '';
  return `// ${chunk.path}${symbolPart} lines ${chunk.startLine}-${chunk.endLine}\n${chunk.content}`;
}
