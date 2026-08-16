import { Injectable } from '@nestjs/common';
import type { ToolCall, ToolDefinition } from '../llm/chat-provider.interface';
import { RetrievalService } from '../retrieval/retrieval.service';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import { FilesRepository } from '../db/repositories/files.repository';
import { SEARCH_CODE_TOOL, searchCodeTool } from './executors/search-code.tool';
import { READ_FILE_TOOL, readFileTool } from './executors/read-file.tool';
import { LIST_FILES_TOOL, listFilesTool } from './executors/list-files.tool';
import { FIND_REFERENCES_TOOL, findReferencesTool } from './executors/find-references.tool';

/** Owned here (not in `chat/`) so the agent loop — an orchestrator — depends on this, never the reverse. */
export interface ToolExecutor {
  readonly definitions: ToolDefinition[];
  execute(projectId: string, call: ToolCall): Promise<string>;
}

@Injectable()
export class ToolRegistry implements ToolExecutor {
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
  async execute(projectId: string, call: ToolCall): Promise<string> {
    try {
      switch (call.name) {
        case 'search_code':
          return await searchCodeTool(this.retrievalService, projectId, call.args);
        case 'read_file':
          return await readFileTool(this.projectsRepository, projectId, call.args);
        case 'list_files':
          return await listFilesTool(this.filesRepository, projectId, call.args);
        case 'find_references':
          return await findReferencesTool(this.retrievalService, projectId, call.args);
        default:
          return `Error: unknown tool "${call.name}".`;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return `Error: ${message}`;
    }
  }
}
