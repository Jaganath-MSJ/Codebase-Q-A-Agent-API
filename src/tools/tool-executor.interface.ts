import type { ToolCall, ToolDefinition } from '../llm/chat-provider.interface';
import type { EvidenceRef } from '../common/citation-parser';

/**
 * `regions` are the concrete file ranges this call surfaced — every one
 * becomes a numbered evidence-ledger entry (see `chat/evidence-ledger.ts`).
 * Only `search_code` and `read_file` ever populate it; `list_files` and
 * `find_references` return locations/listings as plain `note` text, per
 * docs/phases/phase-7-agentic-search.md §4. `note` carries everything else —
 * errors, "no results", a file listing.
 */
export interface ToolExecutionResult {
  regions: EvidenceRef[];
  note?: string;
}

/** Owned here (not in `chat/`) so the agent loop — an orchestrator — depends on this, never the reverse. */
export interface ToolExecutor {
  readonly definitions: ToolDefinition[];
  execute(projectId: string, call: ToolCall): Promise<ToolExecutionResult>;
}
