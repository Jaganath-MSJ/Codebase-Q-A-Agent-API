import type { ToolDefinition } from '../../llm/chat-provider.interface';
import type { RetrievalService } from '../../retrieval/retrieval.service';
import type { ToolExecutionResult } from '../tool-executor.interface';

export const FIND_REFERENCES_TOOL: ToolDefinition = {
  name: 'find_references',
  description:
    'Find where a symbol is defined and everywhere it is used across the repo.',
  parameters: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Exact identifier name, e.g. validateUser.',
      },
    },
    required: ['symbol'],
  },
};

/**
 * Locations only, deliberately no code content — the workflow this tool
 * exists for is locate-then-read_file, not a second copy of search_code's
 * snippet output.
 */
export async function findReferencesTool(
  retrievalService: RetrievalService,
  projectId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const symbol = typeof args.symbol === 'string' ? args.symbol.trim() : '';
  if (!symbol)
    return {
      regions: [],
      note: 'Error: find_references requires a non-empty "symbol" string argument.',
    };

  const results = await retrievalService.findReferences(projectId, symbol);
  if (results.length === 0)
    return { regions: [], note: `No references to "${symbol}" found.` };

  const byFile = new Map<string, { startLine: number; endLine: number }[]>();
  for (const r of results) {
    const ranges = byFile.get(r.path);
    if (ranges) ranges.push(r);
    else byFile.set(r.path, [r]);
  }

  const note = [...byFile.entries()]
    .map(
      ([path, ranges]) =>
        `${path}: ${ranges.map((r) => `${r.startLine}-${r.endLine}`).join(', ')}`,
    )
    .join('\n');
  return { regions: [], note };
}
