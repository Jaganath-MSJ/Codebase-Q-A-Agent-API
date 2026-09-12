import type { ToolDefinition } from '../../llm/chat-provider.interface';
import type { FilesRepository } from '../../db/repositories/files.repository';
import type { ToolExecutionResult } from '../tool-executor.interface';
import { matchesGlob } from '../../common/glob';

const MAX_RESULTS = 200;
// The matcher is linear-time and safe against pathological patterns, but a
// wildly long glob is never a legitimate model request — reject it cheaply.
const MAX_GLOB_LENGTH = 256;

export const LIST_FILES_TOOL: ToolDefinition = {
  name: 'list_files',
  description: 'List files matching a glob, e.g. "src/**/*.controller.ts". Use to understand structure.',
  parameters: {
    type: 'object',
    properties: {
      glob: { type: 'string', description: 'Glob pattern against repo-relative, forward-slash paths.' },
    },
    required: ['glob'],
  },
};

/** Matches against already-indexed file paths — no fresh disk walk, so it only ever sees what the indexer already kept. */
export async function listFilesTool(
  filesRepository: FilesRepository,
  projectId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const glob = typeof args.glob === 'string' ? args.glob.trim() : '';
  if (!glob) return { regions: [], note: 'Error: list_files requires a non-empty "glob" string argument.' };
  if (glob.length > MAX_GLOB_LENGTH)
    return { regions: [], note: `Error: list_files "glob" is too long (max ${MAX_GLOB_LENGTH} characters).` };

  const files = await filesRepository.findAllByProjectId(projectId);
  const matches = files.map((f) => f.path).filter((path) => matchesGlob(path, glob)).sort();

  if (matches.length === 0) return { regions: [], note: 'No files matched.' };

  const shown = matches.slice(0, MAX_RESULTS);
  const suffix = matches.length > MAX_RESULTS ? `\n... [${matches.length - MAX_RESULTS} more, truncated]` : '';
  return { regions: [], note: shown.join('\n') + suffix };
}
