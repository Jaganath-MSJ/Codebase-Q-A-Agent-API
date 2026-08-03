export interface EvidenceRef {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface Citation {
  marker: number;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

const FENCE_RE = /```[\s\S]*?```/g;
const MARKER_RE = /\[(\d+)\]/g;

export function parseCitations(answerText: string, evidence: EvidenceRef[]): Citation[] {
  const withoutFences = answerText.replace(FENCE_RE, '');

  const seen = new Set<number>();
  const citations: Citation[] = [];

  for (const match of withoutFences.matchAll(MARKER_RE)) {
    const marker = Number(match[1]);
    if (seen.has(marker)) continue;
    if (marker < 1 || marker > evidence.length) continue;

    seen.add(marker);
    const item = evidence[marker - 1]!;
    citations.push({
      marker,
      path: item.path,
      startLine: item.startLine,
      endLine: item.endLine,
      content: item.content,
    });
  }

  return citations;
}
