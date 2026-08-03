export interface EvidenceBlock {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

export const SYSTEM_PROMPT = [
  'Cite every factual claim with [n], where n is a number shown in CONTEXT.',
  'Never invent a number, and never write a file path or line number yourself — only [n].',
  'If CONTEXT does not contain the answer, say exactly what is missing.',
  'Prefer pointing at where something happens, then briefly why.',
  'Quote at most 5 lines.',
].join(' ');

export function buildUserPrompt(evidence: EvidenceBlock[], question: string): string {
  const context = evidence
    .map((block, i) => `[${i + 1}] ${block.path}:${block.startLine}-${block.endLine}\n${block.content}`)
    .join('\n\n');

  return `CONTEXT:\n${context}\n\nQUESTION:\n${question}`;
}
