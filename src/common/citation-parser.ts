export interface EvidenceRef {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  // Only ever set by a multi-project conversation's evidence — see
  // `ChatService.generateRagAnswer`. Passed through, never inspected, so
  // this stays a pure marker-resolution function regardless.
  projectId?: string;
}

export interface Citation {
  marker: number;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  projectId?: string;
}

const FENCE_RE = /```[\s\S]*?```/g;
// [n] is the format the system prompt asks for. Some models (observed:
// Groq's openai/gpt-oss-120b) substitute their own trained-in citation
// style, e.g. 【3】 or 【3†L9-L15】, no matter how the prompt is worded —
// recognized here too so citations still resolve regardless of provider.
// Also observed: a model bundling several markers into one bracket, e.g.
// [2, 3] instead of [2][3] — group 1 captures the whole comma list so each
// number can be split out below.
// Exported so other pure renderers (e.g. conversation-markdown.ts) can find
// the same markers without redefining — and re-derive, rather than diverge
// from, what counts as a citation marker in this system.
export const MARKER_RE = /\[(\d+(?:\s*,\s*\d+)*)\]|【(\d+)(?:†[^】]*)?】/g;

export function parseCitations(
  answerText: string,
  evidence: EvidenceRef[],
): Citation[] {
  const withoutFences = answerText.replace(FENCE_RE, '');

  const seen = new Set<number>();
  const citations: Citation[] = [];

  for (const match of withoutFences.matchAll(MARKER_RE)) {
    const markers = match[1]
      ? match[1].split(',').map((n) => Number(n.trim()))
      : [Number(match[2])];

    for (const marker of markers) {
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
        projectId: item.projectId,
      });
    }
  }

  return citations;
}
