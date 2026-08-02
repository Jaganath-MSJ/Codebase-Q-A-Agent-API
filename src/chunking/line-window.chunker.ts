import type { Chunk, Chunker } from './chunker.interface';

const TARGET_LINES = 60;
const OVERLAP_LINES = 15;
const MIN_CHUNK_LINES = 30;
const BOUNDARY_SEARCH_WINDOW = 20;

const DECLARATION_START = /^\s*(export |function |class |def |const \w+ = )/;
const CLOSING_BRACE = /^}\s*$/;

function isBlankLine(line: string): boolean {
  return line.trim() === '';
}

function findBoundary(lines: string[], start: number, naiveEnd: number): number {
  const floor = Math.max(start + MIN_CHUNK_LINES, start + 1);
  const searchFrom = Math.max(floor, naiveEnd - BOUNDARY_SEARCH_WINDOW);
  const searchTo = Math.min(lines.length, naiveEnd + BOUNDARY_SEARCH_WINDOW);

  let best: number | undefined;
  let bestDistance = Infinity;

  for (let i = searchFrom; i < searchTo; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    let candidate: number | undefined;
    if (DECLARATION_START.test(line)) {
      candidate = i; // break before this declaration
    } else if (CLOSING_BRACE.test(line)) {
      candidate = i + 1; // break after the closing brace
    } else if (isBlankLine(line)) {
      candidate = i + 1; // break after the blank line
    }

    if (candidate === undefined || candidate <= start) continue;

    const distance = Math.abs(candidate - naiveEnd);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best ?? naiveEnd;
}

export class LineWindowChunker implements Chunker {
  chunk(lines: string[]): Chunk[] {
    if (lines.length === 0) return [];

    const chunks: Chunk[] = [];
    let start = 0;
    let ord = 0;

    while (start < lines.length) {
      const naiveEnd = Math.min(start + TARGET_LINES, lines.length);
      const end =
        naiveEnd >= lines.length ? lines.length : findBoundary(lines, start, naiveEnd);

      chunks.push({
        ord,
        startLine: start + 1,
        endLine: end,
        content: lines.slice(start, end).join('\n'),
      });
      ord++;

      if (end >= lines.length) break;
      start = Math.max(start + 1, end - OVERLAP_LINES);
    }

    return chunks;
  }
}
