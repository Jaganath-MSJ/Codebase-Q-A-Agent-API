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
// [n] is the format the system prompt asks for. Some models (observed:
// Groq's openai/gpt-oss-120b) substitute their own trained-in citation
// style, e.g. 【3】 or 【3†L9-L15】, no matter how the prompt is worded —
// recognized here too so citations still resolve regardless of provider.
const MARKER_RE = /\[(\d+)\]|【(\d+)(?:†[^】]*)?】/g;

export function parseCitations(answerText: string, evidence: EvidenceRef[]): Citation[] {
  const withoutFences = answerText.replace(FENCE_RE, '');

  const seen = new Set<number>();
  const citations: Citation[] = [];

  for (const match of withoutFences.matchAll(MARKER_RE)) {
    const marker = Number(match[1] ?? match[2]);
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
