import type { ToolDefinition } from '../../llm/chat-provider.interface';
import type { ProjectsRepository } from '../../db/repositories/projects.repository';
import type { ToolExecutionResult } from '../tool-executor.interface';
import { resolveInside } from '../../common/paths';
import { readSourceFile } from '../../common/read-file';

// A generous default window when no range is given — big enough to see a
// whole small file, small enough that an unranged call on a huge file still
// lands well inside the loop's 4,000-character truncation instead of being
// silently cut off mid-line.
const DEFAULT_WINDOW_LINES = 300;

export const READ_FILE_TOOL: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file, optionally a line range. Prefer a range once you know roughly where to look.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Repo-relative file path, e.g. src/auth/auth.service.ts' },
      startLine: { type: 'number', description: '1-based start line (inclusive). Omit to read from the top.' },
      endLine: {
        type: 'number',
        description: `1-based end line (inclusive). Omit to read up to ${DEFAULT_WINDOW_LINES} lines from startLine.`,
      },
    },
    required: ['path'],
  },
};

/** Every call routes through `resolveInside()` — the model asked to investigate will cheerfully try `../../.env`, and that isn't malice. */
export async function readFileTool(
  projectsRepository: ProjectsRepository,
  projectId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const relPath = typeof args.path === 'string' ? args.path.trim() : '';
  if (!relPath) return { regions: [], note: 'Error: read_file requires a non-empty "path" string argument.' };

  const project = await projectsRepository.findById(projectId);
  if (!project) return { regions: [], note: `Error: project ${projectId} not found.` };

  const root = project.workspacePath ?? project.sourceRef;
  let absPath: string;
  try {
    absPath = resolveInside(root, relPath);
  } catch {
    return { regions: [], note: `Error: path escapes the project workspace: ${relPath}` };
  }

  let lines: string[];
  try {
    ({ lines } = await readSourceFile(absPath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { regions: [], note: `Error: file not found: ${relPath}` };
    }
    throw err;
  }

  const start = Math.max(1, typeof args.startLine === 'number' ? Math.floor(args.startLine) : 1);
  if (start > lines.length) {
    return { regions: [], note: `Error: startLine ${start} is past the end of the file (${lines.length} lines).` };
  }

  const requestedEnd =
    typeof args.endLine === 'number' ? Math.floor(args.endLine) : start + DEFAULT_WINDOW_LINES - 1;
  const end = Math.min(lines.length, requestedEnd);

  return { regions: [{ path: relPath, startLine: start, endLine: end, content: lines.slice(start - 1, end).join('\n') }] };
}
