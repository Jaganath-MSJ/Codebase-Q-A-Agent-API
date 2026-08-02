import { readFile } from 'node:fs/promises';

export interface ReadResult {
  text: string;
  lines: string[];
}

export function toLines(raw: string): ReadResult {
  const normalized = raw.replace(/\r\n/g, '\n');

  if (normalized === '') {
    return { text: normalized, lines: [] };
  }

  const lines = normalized.split('\n');
  if (normalized.endsWith('\n')) {
    lines.pop();
  }

  return { text: normalized, lines };
}

export async function readSourceFile(absPath: string): Promise<ReadResult> {
  const raw = await readFile(absPath, 'utf8');
  return toLines(raw);
}
