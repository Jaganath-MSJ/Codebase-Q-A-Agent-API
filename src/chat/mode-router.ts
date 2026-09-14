type ChatMode = 'fast' | 'thorough';

// Keyword heuristics from docs/phases/phase-7-agentic-search.md §5 — get most
// of the value for nearly no cost. Deliberately loose (e.g. "what...break"
// spans the whole question, not just an adjacent phrase) since a false
// escalation to Thorough costs latency, while a false stay-on-Fast costs a
// vaguer answer — the cheaper failure mode.
const ESCALATE_PATTERNS: RegExp[] = [
  /what.*\bbreaks?\b/i,
  /\btrace\b/i,
  /\beverywhere\b/i,
  /all the places/i,
  /why does/i,
  /how does.*\bflow\b/i,
  /\bunused\b/i,
  /dead code/i,
  /\bimpact\b/i,
];

/** Escalates to Thorough (agentic) on investigation-shaped questions; everything else stays on Fast (RAG). */
export function classifyMode(question: string): ChatMode {
  return ESCALATE_PATTERNS.some((pattern) => pattern.test(question))
    ? 'thorough'
    : 'fast';
}
