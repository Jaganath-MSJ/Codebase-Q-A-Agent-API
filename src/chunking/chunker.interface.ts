export interface Chunk {
  ord: number;
  startLine: number;
  endLine: number;
  content: string;
}

export interface Chunker {
  chunk(lines: string[]): Chunk[];
}
