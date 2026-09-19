import type {
  ChatProvider,
  ChatStopReason,
  ChatUsage,
  PriorTurn,
  ToolCall,
  ToolResultTurn,
} from '../llm/chat-provider.interface';
import type { ToolExecutor } from '../tools/tool-executor.interface';
import {
  type EvidenceEntry,
  formatEvidenceEntry,
  recordEvidence,
} from './evidence-ledger';

// Cap it at 8 steps from the very first run — an unbounded loop against a
// free tier on its first outing is how you lose a day's quota in minutes.
const MAX_STEPS = 8;
// A second, independent cap alongside the step count: each step resends the
// whole growing conversation, so input tokens alone can blow past a sane
// budget well before 8 steps on a chatty model. Checked between steps.
const MAX_TOTAL_TOKENS = 50_000;
// Generous per-step output cap — a step may emit the full final
// answer, so match the RAG generation cap. (MAX_TOTAL_TOKENS still bounds the
// whole loop across steps.)
const AGENT_MAX_TOKENS = 2048;
// A `list_files`-style tool on a large repo can otherwise return tens of
// thousands of tokens and blow the context in one call.
const TOOL_RESULT_TRUNCATE_CHARS = 4000;

interface AgentTraceEntry {
  tool: string;
  args: Record<string, unknown>;
  resultSummary: string;
  ms: number;
}

type AgentStopReason = ChatStopReason | 'budget_exhausted';

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | {
      type: 'done';
      text: string;
      trace: AgentTraceEntry[];
      usage: ChatUsage;
      stopReason: AgentStopReason;
      evidence: EvidenceEntry[];
      // The provider that served the final step (whichever the failover wrapper
      // landed on) — so the persisted turn records who actually answered.
      servedBy?: string;
    };

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n... [truncated]` : text;
}

/**
 * Loops the model against `toolRegistry` until it stops requesting tools or
 * the step budget runs out. Every tool result is fed back as a `tool` turn
 * before the next step, so the model can chain calls (7.2+) — for 7.1 there
 * is exactly one tool, `search_code`, so the interesting behaviour is purely
 * the loop calling it once and terminating.
 */
export async function* runAgentLoop(
  chatProvider: ChatProvider,
  toolRegistry: ToolExecutor,
  projectId: string,
  system: string,
  question: string,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent> {
  if (!chatProvider.supportsTools) {
    throw new Error(
      `Chat provider '${chatProvider.id}' does not support tool calling`,
    );
  }

  const priorTurns: PriorTurn[] = [];
  const trace: AgentTraceEntry[] = [];
  let evidence: EvidenceEntry[] = [];
  let usage: ChatUsage = { inputTokens: 0, outputTokens: 0 };
  let totalTokens = 0;
  let finalText = '';
  let servedBy: string | undefined;

  for (let step = 1; step <= MAX_STEPS; step++) {
    const pendingCalls: ToolCall[] = [];
    let stepText = '';
    let stopReason: ChatStopReason = 'stop';

    for await (const event of chatProvider.stream(
      {
        system,
        user: question,
        tools: toolRegistry.definitions,
        priorTurns,
        maxTokens: AGENT_MAX_TOKENS,
      },
      signal,
    )) {
      if (event.type === 'text') {
        stepText += event.delta;
        yield { type: 'text', delta: event.delta };
      } else if (event.type === 'tool_call') {
        pendingCalls.push({
          id: event.id,
          name: event.name,
          args: event.args,
          providerData: event.providerData,
        });
      } else if (event.type === 'usage') {
        // Accumulated across every step, not overwritten — each step resends
        // the whole growing conversation, so the total cost of a multi-step
        // answer is the sum, not just the last step's own numbers.
        usage = {
          inputTokens: (usage.inputTokens ?? 0) + event.inputTokens,
          outputTokens: (usage.outputTokens ?? 0) + event.outputTokens,
        };
        totalTokens += event.inputTokens + event.outputTokens;
      } else if (event.type === 'done') {
        stopReason = event.stopReason;
        servedBy = event.servedBy;
      }
    }

    finalText += stepText;
    if (signal.aborted) {
      yield {
        type: 'done',
        text: finalText,
        trace,
        usage,
        stopReason: 'error',
        evidence,
        servedBy,
      };
      return;
    }

    if (stopReason !== 'tool_use' || pendingCalls.length === 0) {
      yield {
        type: 'done',
        text: finalText,
        trace,
        usage,
        stopReason,
        evidence,
        servedBy,
      };
      return;
    }

    if (totalTokens >= MAX_TOTAL_TOKENS) {
      yield {
        type: 'done',
        text: finalText,
        trace,
        usage,
        stopReason: 'budget_exhausted',
        evidence,
        servedBy,
      };
      return;
    }

    priorTurns.push({
      role: 'assistant',
      content: stepText,
      toolCalls: pendingCalls,
    });

    const results: ToolResultTurn[] = [];
    for (const call of pendingCalls) {
      yield { type: 'tool_call', name: call.name, args: call.args };
      const startedAt = Date.now();
      const { regions, note } = await toolRegistry.execute(projectId, call);

      // Every region becomes a numbered evidence-ledger entry — markers stay
      // sequential across the whole trajectory, not reset per call.
      const created = recordEvidence(evidence, regions);
      evidence = [...evidence, ...created];

      const rendered = [created.map(formatEvidenceEntry).join('\n\n'), note]
        .filter(Boolean)
        .join('\n\n');
      const text = truncate(
        rendered || 'No output.',
        TOOL_RESULT_TRUNCATE_CHARS,
      );

      trace.push({
        tool: call.name,
        args: call.args,
        resultSummary: text,
        ms: Date.now() - startedAt,
      });
      results.push({ toolCallId: call.id, name: call.name, content: text });
    }
    priorTurns.push({ role: 'tool', results });
  }

  yield {
    type: 'done',
    text: finalText,
    trace,
    usage,
    stopReason: 'budget_exhausted',
    evidence,
    servedBy,
  };
}
