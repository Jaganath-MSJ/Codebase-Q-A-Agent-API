import { Injectable } from '@nestjs/common';
import type { ToolCall, ToolDefinition } from '../llm/chat-provider.interface';
import { RetrievalService } from '../retrieval/retrieval.service';
import { SEARCH_CODE_TOOL, searchCodeTool } from './executors/search-code.tool';

/** Owned here (not in `chat/`) so the agent loop — an orchestrator — depends on this, never the reverse. */
export interface ToolExecutor {
  readonly definitions: ToolDefinition[];
  execute(projectId: string, call: ToolCall): Promise<string>;
}

@Injectable()
export class ToolRegistry implements ToolExecutor {
  readonly definitions: ToolDefinition[] = [SEARCH_CODE_TOOL];

  constructor(private readonly retrievalService: RetrievalService) {}

  /** Never throws — a failed tool call becomes text the model sees and can react to, not a crashed loop. */
  async execute(projectId: string, call: ToolCall): Promise<string> {
    try {
      switch (call.name) {
        case 'search_code':
          return await searchCodeTool(this.retrievalService, projectId, call.args);
        default:
          return `Error: unknown tool "${call.name}".`;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return `Error: ${message}`;
    }
  }
}
