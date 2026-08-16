import type { EvidenceRef } from '../common/citation-parser';

export interface EvidenceEntry extends EvidenceRef {
  marker: number;
}

/**
 * Assigns the next sequential markers to newly-observed regions, given the
 * entries already recorded. Pure: the agent loop owns the accumulating array
 * and threads it through, so markers stay sequential across the *entire*
 * trajectory (not reset per tool call) — matching how `parseCitations`
 * resolves `[n]` positionally against the final evidence array.
 */
export function recordEvidence(existing: EvidenceEntry[], regions: EvidenceRef[]): EvidenceEntry[] {
  return regions.map((region, i) => ({ ...region, marker: existing.length + i + 1 }));
}

/** Renders one evidence entry as the model-facing block from docs/phases/phase-7-agentic-search.md §4. */
export function formatEvidenceEntry(entry: EvidenceEntry): string {
  return `[${entry.marker}] ${entry.path}:${entry.startLine}-${entry.endLine}\n\`\`\`\n${entry.content}\n\`\`\``;
}
