import { describe, expect, it } from 'vitest';
import { runAgentLoop } from './agent.loop';
import type {
  ChatCompletion,
  ChatEvent,
  ChatProvider,
  ToolCall,
  ToolDefinition,
} from '../llm/chat-provider.interface';
import type { ToolExecutor } from '../tools/tool.registry';

class ScriptedChatProvider implements ChatProvider {
  readonly id = 'scripted:test';
  readonly contextWindow = 100_000;
  readonly supportsTools: boolean;
  step = 0;

  constructor(
    private readonly scriptFor: (step: number) => ChatEvent[],
    supportsTools = true,
  ) {
    this.supportsTools = supportsTools;
  }

  async *stream(): AsyncIterable<ChatEvent> {
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

  async execute(_projectId: string, call: ToolCall): Promise<string> {
    this.calls.push(call);
    return `result for ${call.name}`;
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
      expect.objectContaining({ type: 'done', text: 'The answer.', stopReason: 'stop' }),
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
});
