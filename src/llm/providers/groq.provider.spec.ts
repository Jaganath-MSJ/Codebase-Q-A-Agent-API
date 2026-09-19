import { describe, it, expect } from 'vitest';
import { GroqChatProvider } from './groq.provider';
import type { ConfigService } from '../../config/config.service';
import type { ChatEvent, ChatRequest } from '../chat-provider.interface';

/**
 * QA pass — TC-LLM-0xx.
 *
 * The SDK call itself is not interesting; the mapping around it is. Two things
 * downstream code relies on and would break silently if they changed:
 *   - the stream always ends `…text*, usage, done` in that order
 *   - a missing field degrades to a default rather than `undefined` leaking out
 *
 * The client is built in the constructor, so the fake is swapped in afterwards.
 * That reaches past the public surface deliberately — the alternative is not
 * testing the mapping at all.
 */

const request: ChatRequest = {
  system: 'you are a code assistant',
  user: 'what does validateUser do?',
};

function providerWith(client: unknown): GroqChatProvider {
  const provider = new GroqChatProvider({
    groqApiKey: 'test-key',
  } as unknown as ConfigService);
  (provider as unknown as { client: unknown }).client = client;
  return provider;
}

function completionClient(response: unknown) {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      chat: {
        completions: {
          create: (body: unknown) => {
            calls.push(body);
            return Promise.resolve(response);
          },
        },
      },
    },
  };
}

function streamClient(chunks: unknown[]) {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      chat: {
        completions: {
          create: (body: unknown) => {
            calls.push(body);
            return Promise.resolve({
              async *[Symbol.asyncIterator]() {
                for (const chunk of chunks) yield chunk;
              },
            });
          },
        },
      },
    },
  };
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('GroqChatProvider — identity', () => {
  it('TC-LLM-001 reports a namespaced id and its context window', () => {
    const provider = providerWith({});
    expect(provider.id).toBe('groq:openai/gpt-oss-120b');
    expect(provider.contextWindow).toBe(131_072);
  });

  it('TC-LLM-002 declares that it does not support tools', () => {
    // Load-bearing for failover: a tool-using request must never be handed to
    // this provider.
    expect(providerWith({}).supportsTools).toBe(false);
  });
});

describe('GroqChatProvider.complete', () => {
  it('TC-LLM-010 maps content and usage', async () => {
    const { client } = completionClient({
      choices: [{ message: { content: 'the answer' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });

    const result = await providerWith(client).complete(request);

    expect(result.text).toBe('the answer');
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(result.servedBy).toBe('groq:openai/gpt-oss-120b');
  });

  it('TC-LLM-011 degrades missing content to an empty string', async () => {
    const { client } = completionClient({ choices: [], usage: undefined });
    const result = await providerWith(client).complete(request);
    expect(result.text).toBe('');
  });

  it('TC-LLM-012 tolerates a null message content', async () => {
    const { client } = completionClient({
      choices: [{ message: { content: null } }],
    });
    expect((await providerWith(client).complete(request)).text).toBe('');
  });

  it('TC-LLM-013 sends system and user as separate messages', async () => {
    const { client, calls } = completionClient({ choices: [] });
    await providerWith(client).complete(request);
    expect(calls[0]).toMatchObject({
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
    });
  });

  it('TC-LLM-014 forwards maxTokens as max_completion_tokens', async () => {
    const { client, calls } = completionClient({ choices: [] });
    await providerWith(client).complete({ ...request, maxTokens: 512 });
    expect(calls[0]).toMatchObject({ max_completion_tokens: 512 });
  });
});

describe('GroqChatProvider.stream', () => {
  it('TC-LLM-020 emits text deltas, then usage, then done — in that order', async () => {
    const { client } = streamClient([
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        x_groq: { usage: { prompt_tokens: 10, completion_tokens: 2 } },
      },
    ]);

    const events = await collect(providerWith(client).stream(request));

    expect(events.map((e) => e.type)).toEqual([
      'text',
      'text',
      'usage',
      'done',
    ]);
    expect(events.at(-1)).toEqual({
      type: 'done',
      stopReason: 'stop',
      servedBy: 'groq:openai/gpt-oss-120b',
    });
  });

  it('TC-LLM-021 reconstructs the full text from the deltas', async () => {
    const { client } = streamClient([
      { choices: [{ delta: { content: 'a' } }] },
      { choices: [{ delta: { content: 'b' } }] },
      { choices: [{ delta: { content: 'c' } }] },
    ]);

    const events = await collect(providerWith(client).stream(request));
    const text = events
      .filter(
        (e): e is Extract<ChatEvent, { type: 'text' }> => e.type === 'text',
      )
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('abc');
  });

  it('TC-LLM-022 skips empty deltas rather than emitting blank events', async () => {
    const { client } = streamClient([
      { choices: [{ delta: { content: '' } }] },
      { choices: [{ delta: {} }] },
      { choices: [{ delta: { content: 'real' } }] },
    ]);

    const events = await collect(providerWith(client).stream(request));
    expect(events.filter((e) => e.type === 'text')).toHaveLength(1);
  });

  it('TC-LLM-023 still terminates correctly on an empty stream', async () => {
    const { client } = streamClient([]);
    const events = await collect(providerWith(client).stream(request));
    expect(events.map((e) => e.type)).toEqual(['usage', 'done']);
    expect(events[0]).toEqual({
      type: 'usage',
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('TC-LLM-024 defaults usage to zero when the provider reports none', async () => {
    const { client } = streamClient([
      { choices: [{ delta: { content: 'x' } }] },
    ]);
    const events = await collect(providerWith(client).stream(request));
    expect(events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  describe('TC-LLM-030..033 — stop-reason mapping', () => {
    const stopReasonFor = async (finish_reason: string | null) => {
      const { client } = streamClient([
        { choices: [{ delta: { content: 'x' }, finish_reason }] },
      ]);
      const events = await collect(providerWith(client).stream(request));
      const done = events.at(-1) as Extract<ChatEvent, { type: 'done' }>;
      return done.stopReason;
    };

    it('TC-LLM-030 maps "length" to length — the max_tokens cap was hit', async () => {
      expect(await stopReasonFor('length')).toBe('length');
    });

    it('TC-LLM-031 maps tool_calls and function_call to tool_use', async () => {
      expect(await stopReasonFor('tool_calls')).toBe('tool_use');
      expect(await stopReasonFor('function_call')).toBe('tool_use');
    });

    it('TC-LLM-032 maps "stop" and anything unrecognised to stop', async () => {
      expect(await stopReasonFor('stop')).toBe('stop');
      expect(await stopReasonFor('content_filter')).toBe('stop');
    });

    it('TC-LLM-033 defaults to stop when no finish_reason ever arrives', async () => {
      expect(await stopReasonFor(null)).toBe('stop');
    });
  });

  it('TC-LLM-040 requests a streaming completion', async () => {
    const { client, calls } = streamClient([]);
    await collect(providerWith(client).stream(request));
    expect(calls[0]).toMatchObject({ stream: true });
  });
});
