import { describe, expect, it } from 'vitest';
import { runAgentLoop } from './agent.loop';
import type {
  ChatCompletion,
  ChatEvent,
  ChatProvider,
  ChatRequest,
  ToolCall,
  ToolDefinition,
} from '../llm/chat-provider.interface';
import type { ToolExecutionResult, ToolExecutor } from '../tools/tool-executor.interface';

class ScriptedChatProvider implements ChatProvider {
  readonly id = 'scripted:test';
  readonly contextWindow = 100_000;
  readonly supportsTools: boolean;
  step = 0;
  receivedRequests: ChatRequest[] = [];

  constructor(
    private readonly scriptFor: (step: number) => ChatEvent[],
    supportsTools = true,
  ) {
    this.supportsTools = supportsTools;
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatEvent> {
    this.receivedRequests.push(req);
    const events = this.scriptFor(this.step);
    this.step++;
    for (const event of events) yield event;
  }

  async complete(): Promise<ChatCompletion> {
    throw new Error('ScriptedChatProvider.complete is not used by the agent loop');
  }
}

class FakeToolExecutor implements ToolExecutor {
  readonly definitions: ToolDefinition[] = [
    { name: 'search_code', description: 'test tool', parameters: {} },
  ];
  calls: ToolCall[] = [];

  async execute(_projectId: string, call: ToolCall): Promise<ToolExecutionResult> {
    this.calls.push(call);
    return { regions: [], note: `result for ${call.name}` };
  }
}

/** Returns one fresh, distinct region per call — for evidence-ledger marker tests. */
class RegionToolExecutor implements ToolExecutor {
  readonly definitions: ToolDefinition[] = [
    { name: 'search_code', description: 'test tool', parameters: {} },
  ];
  calls = 0;

  async execute(): Promise<ToolExecutionResult> {
    this.calls++;
    return { regions: [{ path: `src/${this.calls}.ts`, startLine: 1, endLine: 1, content: `content ${this.calls}` }] };
  }
}

async function drain(loop: AsyncGenerator<import('./agent.loop').AgentEvent>) {
  const events: import('./agent.loop').AgentEvent[] = [];
  for await (const event of loop) events.push(event);
  return events;
}

describe('runAgentLoop', () => {
  it('terminates in one step when the model answers without calling a tool', async () => {
    const provider = new ScriptedChatProvider(() => [
      { type: 'text', delta: 'The answer.' },
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
      { type: 'done', stopReason: 'stop' },
    ]);
    const tools = new FakeToolExecutor();

    const events = await drain(
      runAgentLoop(provider, tools, 'proj-1', 'system', 'question', new AbortController().signal),
    );

    const done = events.at(-1);
    expect(done).toEqual(
      expect.objectContaining({ type: 'done', text: 'The answer.', stopReason: 'stop', evidence: [] }),
    );
    expect(tools.calls).toHaveLength(0);
    expect(provider.step).toBe(1);
  });

  it('executes one tool call and terminates once the model answers on the next step', async () => {
    const provider = new ScriptedChatProvider((step) =>
      step === 0
        ? [
            { type: 'tool_call', id: 'call-1', name: 'search_code', args: { query: 'validateUser' } },
            { type: 'done', stopReason: 'tool_use' },
          ]
        : [{ type: 'text', delta: 'Found it.' }, { type: 'done', stopReason: 'stop' }],
    );
    const tools = new FakeToolExecutor();

    const events = await drain(
      runAgentLoop(provider, tools, 'proj-1', 'system', 'question', new AbortController().signal),
    );

    expect(events).toContainEqual({
      type: 'tool_call',
      name: 'search_code',
      args: { query: 'validateUser' },
    });
    const done = events.at(-1);
    expect(done).toEqual(expect.objectContaining({ type: 'done', text: 'Found it.', stopReason: 'stop' }));
    expect(tools.calls).toHaveLength(1);
    expect(provider.step).toBe(2);
  });

  it('stops after exactly 8 steps and reports budget_exhausted when the model never stops calling tools', async () => {
    const provider = new ScriptedChatProvider(() => [
      { type: 'tool_call', id: 'call-loop', name: 'search_code', args: { query: 'x' } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
    const tools = new FakeToolExecutor();

    const events = await drain(
      runAgentLoop(provider, tools, 'proj-1', 'system', 'question', new AbortController().signal),
    );

    const done = events.at(-1);
    expect(done).toEqual(expect.objectContaining({ type: 'done', stopReason: 'budget_exhausted' }));
    expect(provider.step).toBe(8);
    expect(tools.calls).toHaveLength(8);
  });

  it('stops with budget_exhausted once accumulated tokens cross the cap, even well under the 8-step limit', async () => {
    const provider = new ScriptedChatProvider(() => [
      { type: 'tool_call', id: 'call-loop', name: 'search_code', args: { query: 'x' } },
      { type: 'usage', inputTokens: 20_000, outputTokens: 5_000 },
      { type: 'done', stopReason: 'tool_use' },
    ]);
    const tools = new FakeToolExecutor();

    const events = await drain(
      runAgentLoop(provider, tools, 'proj-1', 'system', 'question', new AbortController().signal),
    );

    const done = events.at(-1);
    expect(done).toEqual(expect.objectContaining({ type: 'done', stopReason: 'budget_exhausted' }));
    // 25,000 tokens/step crosses the 50,000 cap after step 2, well short of MAX_STEPS=8.
    expect(provider.step).toBe(2);
    expect(tools.calls).toHaveLength(1);
  });

  it('throws up front rather than silently misbehaving when the provider lacks tool support', async () => {
    const provider = new ScriptedChatProvider(() => [], false);
    const tools = new FakeToolExecutor();

    await expect(
      drain(runAgentLoop(provider, tools, 'proj-1', 'system', 'question', new AbortController().signal)),
    ).rejects.toThrow(/does not support tool calling/);
  });

  it('records every tool-surfaced region in the evidence ledger and renders [n] blocks back to the model', async () => {
    const provider = new ScriptedChatProvider((step) =>
      step === 0
        ? [{ type: 'tool_call', id: 'call-1', name: 'search_code', args: { query: 'x' } }, { type: 'done', stopReason: 'tool_use' }]
        : [{ type: 'text', delta: 'Done.' }, { type: 'done', stopReason: 'stop' }],
    );
    class TwoRegionToolExecutor implements ToolExecutor {
      readonly definitions: ToolDefinition[] = [{ name: 'search_code', description: 'test', parameters: {} }];
      async execute(): Promise<ToolExecutionResult> {
        return {
          regions: [
            { path: 'src/a.ts', startLine: 1, endLine: 3, content: 'a' },
            { path: 'src/b.ts', startLine: 5, endLine: 7, content: 'b' },
          ],
        };
      }
    }

    const events = await drain(
      runAgentLoop(provider, new TwoRegionToolExecutor(), 'proj-1', 'system', 'question', new AbortController().signal),
    );

    const done = events.at(-1) as { evidence: unknown };
    expect(done.evidence).toEqual([
      { path: 'src/a.ts', startLine: 1, endLine: 3, content: 'a', marker: 1 },
      { path: 'src/b.ts', startLine: 5, endLine: 7, content: 'b', marker: 2 },
    ]);

    // The next model call must see the rendered [n] blocks, not raw unmarkered content.
    const secondRequest = provider.receivedRequests[1]!;
    const toolTurn = secondRequest.priorTurns?.find((t) => t.role === 'tool');
    expect(toolTurn && 'results' in toolTurn ? toolTurn.results[0]?.content : undefined).toContain(
      '[1] src/a.ts:1-3',
    );
    expect(toolTurn && 'results' in toolTurn ? toolTurn.results[0]?.content : undefined).toContain(
      '[2] src/b.ts:5-7',
    );
  });

  it('keeps markers sequential across multiple steps, not reset per tool call', async () => {
    const provider = new ScriptedChatProvider((step) =>
      step < 2
        ? [{ type: 'tool_call', id: `call-${step}`, name: 'search_code', args: {} }, { type: 'done', stopReason: 'tool_use' }]
        : [{ type: 'text', delta: 'Done.' }, { type: 'done', stopReason: 'stop' }],
    );

    const events = await drain(
      runAgentLoop(provider, new RegionToolExecutor(), 'proj-1', 'system', 'question', new AbortController().signal),
    );

    const done = events.at(-1) as { evidence: { marker: number }[] };
    expect(done.evidence.map((e) => e.marker)).toEqual([1, 2]);
  });
});
