import { Injectable, Logger } from '@nestjs/common';
import type { ToolCall, ToolDefinition } from '../llm/chat-provider.interface';
import type {
  ToolExecutionResult,
  ToolExecutor,
} from './tool-executor.interface';
import { RetrievalService } from '../retrieval/retrieval.service';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import { FilesRepository } from '../db/repositories/files.repository';
import { SEARCH_CODE_TOOL, searchCodeTool } from './executors/search-code.tool';
import { READ_FILE_TOOL, readFileTool } from './executors/read-file.tool';
import { LIST_FILES_TOOL, listFilesTool } from './executors/list-files.tool';
import {
  FIND_REFERENCES_TOOL,
  findReferencesTool,
} from './executors/find-references.tool';

@Injectable()
export class ToolRegistry implements ToolExecutor {
  private readonly logger = new Logger(ToolRegistry.name);

  readonly definitions: ToolDefinition[] = [
    SEARCH_CODE_TOOL,
    READ_FILE_TOOL,
    LIST_FILES_TOOL,
    FIND_REFERENCES_TOOL,
  ];

  constructor(
    private readonly retrievalService: RetrievalService,
    private readonly projectsRepository: ProjectsRepository,
    private readonly filesRepository: FilesRepository,
  ) {}

  /** Never throws — a failed tool call becomes text the model sees and can react to, not a crashed loop. */
  async execute(
    projectId: string,
    call: ToolCall,
  ): Promise<ToolExecutionResult> {
    try {
      switch (call.name) {
        case 'search_code':
          return await searchCodeTool(
            this.retrievalService,
            projectId,
            call.args,
          );
        case 'read_file':
          return await readFileTool(
            this.projectsRepository,
            projectId,
            call.args,
          );
        case 'list_files':
          return await listFilesTool(
            this.filesRepository,
            projectId,
            call.args,
          );
        case 'find_references':
          return await findReferencesTool(
            this.retrievalService,
            projectId,
            call.args,
          );
        default:
          return { regions: [], note: `Error: unknown tool "${call.name}".` };
      }
    } catch (err) {
      return { regions: [], note: this.safeErrorNote(call, err) };
    }
  }

  /**
   * Builds the model-visible note for a failed tool call — without the driver's
   * own message.
   *
   * A note is prompt text, so anything put here is disclosed to the provider and
   * may be echoed back to the user. Driver messages are exactly the wrong shape
   * for that: Node's `fs` errors embed the absolute workspace path (which
   * CLAUDE.md keeps server-side), and drizzle builds its message as
   * `Failed query: <SQL>\nparams: <bound params>` — where, for `search_code`,
   * the params are the 768-float query embedding, enough on its own to blow past
   * the agent loop's 4,000-character result budget.
   *
   * So the real error is logged server-side and the model gets the error CODE
   * plus the argument it supplied itself, which is what it can actually act on.
   * Codes (`EISDIR`, `EACCES`, `42P01`, …) carry no path or payload.
   */
  private safeErrorNote(call: ToolCall, err: unknown): string {
    this.logger.error(
      `Tool "${call.name}" failed: ${
        err instanceof Error ? (err.stack ?? err.message) : String(err)
      }`,
    );

    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return code
      ? `Error: ${call.name} failed (${code}).`
      : `Error: ${call.name} failed.`;
  }
}
