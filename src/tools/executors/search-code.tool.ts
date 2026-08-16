import type { ToolDefinition } from '../../llm/chat-provider.interface';
import type { RetrievalMode, RetrievalService } from '../../retrieval/retrieval.service';

export const SEARCH_CODE_TOOL: ToolDefinition = {
  name: 'search_code',
  description:
    'Hybrid search over the codebase. Returns ranked snippets with file paths and line ranges. Use this first to locate relevant code.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language or identifier search query.' },
      mode: {
        type: 'string',
        enum: ['hybrid', 'exact'],
        description: 'hybrid (default) blends vector and lexical search; exact matches identifiers literally.',
      },
      limit: { type: 'number', description: 'Max results to return (default 10, max 20).' },
    },
    required: ['query'],
  },
};

/** Formats results as plain path:line references — no `[n]` markers yet, since the evidence ledger is Phase 7.3. */
export async function searchCodeTool(
  retrievalService: RetrievalService,
  projectId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return 'Error: search_code requires a non-empty "query" string argument.';

  const mode: RetrievalMode = args.mode === 'exact' ? 'fts' : 'hybrid';
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 20) : 10;

  const results = await retrievalService.search(projectId, query, mode, limit);
  if (results.length === 0) return 'No results.';

  return results
    .map((r, i) => `${i + 1}. ${r.path}:${r.startLine}-${r.endLine} (score ${r.score.toFixed(3)})\n${r.content}`)
    .join('\n\n');
}
