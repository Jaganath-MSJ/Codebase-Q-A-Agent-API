import { describe, it, expect, vi } from 'vitest';
import { FailoverChatProvider, isRetriableProviderError } from './failover';
import type { ChatEvent, ChatProvider, ChatRequest } from './chat-provider.interface';

const REQ: ChatRequest = { system: 's', user: 'u' };
const TOOL_REQ: ChatRequest = { ...REQ, tools: [{ name: 't', description: 'd', parameters: {} }] };

function status(code: number): Error {
  return Object.assign(new Error(`http ${code}`), { status: code });
}

function provider(opts: Partial<ChatProvider> = {}): ChatProvider {
  return {
    id: 'primary',
    contextWindow: 1000,
    supportsTools: true,
    complete: async () => ({ text: 'PRIMARY', usage: {} }),
    // eslint-disable-next-line require-yield
    stream: async function* () {
      yield { type: 'text', delta: 'PRIMARY' };
    },
    ...opts,
  };
}

async function collect(it: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe('isRetriableProviderError', () => {
  it('treats 429 and 503 (number or string) as retriable', () => {
    expect(isRetriableProviderError(status(429))).toBe(true);
    expect(isRetriableProviderError(status(503))).toBe(true);
    expect(isRetriableProviderError({ statusCode: 429 })).toBe(true);
    expect(isRetriableProviderError({ code: '503' })).toBe(true);
    expect(isRetriableProviderError({ response: { status: 429 } })).toBe(true);
  });

  it('treats Gemini RESOURCE_EXHAUSTED / UNAVAILABLE messages as retriable', () => {
    expect(isRetriableProviderError(new Error('got status: RESOURCE_EXHAUSTED for quota'))).toBe(true);
    expect(isRetriableProviderError(new Error('503 Service UNAVAILABLE'))).toBe(true);
  });

  it('does NOT retry on non-retriable errors', () => {
    expect(isRetriableProviderError(status(400))).toBe(false);
    expect(isRetriableProviderError(status(401))).toBe(false);
    expect(isRetriableProviderError(new Error('boom'))).toBe(false);
    expect(isRetriableProviderError(new Error('order 429 shipped'))).toBe(false); // number w/o quota word
    expect(isRetriableProviderError(null)).toBe(false);
    expect(isRetriableProviderError('429')).toBe(false);
  });
});

describe('FailoverChatProvider.complete', () => {
  it('fails over to the secondary on a primary 429', async () => {
    const complete = vi.fn().mockResolvedValue({ text: 'SECONDARY', usage: {} });
    const primary = provider({ complete: vi.fn().mockRejectedValue(status(429)) });
    const secondary = provider({ id: 'secondary', complete });
    const res = await new FailoverChatProvider(primary, secondary).complete(REQ);
    expect(res.text).toBe('SECONDARY');
    expect(complete).toHaveBeenCalledOnce();
  });

  it('does NOT fail over on a non-retriable error', async () => {
    const secondaryComplete = vi.fn();
    const primary = provider({ complete: vi.fn().mockRejectedValue(status(400)) });
    const secondary = provider({ id: 'secondary', complete: secondaryComplete });
    await expect(new FailoverChatProvider(primary, secondary).complete(REQ)).rejects.toMatchObject({
      status: 400,
    });
    expect(secondaryComplete).not.toHaveBeenCalled();
  });

  it('reports servedBy as the secondary after a failover, not the primary', async () => {
    const primary = provider({ id: 'gemini', complete: vi.fn().mockRejectedValue(status(429)) });
    const secondary = provider({
      id: 'groq',
      complete: async () => ({ text: 'SECONDARY', usage: {}, servedBy: 'groq' }),
    });
    const res = await new FailoverChatProvider(primary, secondary).complete(REQ);
    // `id` is still the primary's, but the turn was actually served by the secondary.
    expect(res.servedBy).toBe('groq');
  });

  it('does NOT fail over a tool request to a non-tool secondary', async () => {
    const secondaryComplete = vi.fn();
    const primary = provider({ supportsTools: true, complete: vi.fn().mockRejectedValue(status(429)) });
    const secondary = provider({ id: 'secondary', supportsTools: false, complete: secondaryComplete });
    await expect(new FailoverChatProvider(primary, secondary).complete(TOOL_REQ)).rejects.toMatchObject({
      status: 429,
    });
    expect(secondaryComplete).not.toHaveBeenCalled();
  });
});

describe('FailoverChatProvider.stream', () => {
  it('fails over when the primary errors BEFORE any text delta', async () => {
    const primary = provider({
      // eslint-disable-next-line require-yield
      stream: async function* () {
        throw status(503);
      },
    });
    const secondary = provider({
      id: 'secondary',
      stream: async function* () {
        yield { type: 'text', delta: 'SECONDARY' };
        yield { type: 'done', stopReason: 'stop' };
      },
    });
    const events = await collect(new FailoverChatProvider(primary, secondary).stream(REQ));
    expect(events).toEqual([
      { type: 'text', delta: 'SECONDARY' },
      { type: 'done', stopReason: 'stop' },
    ]);
  });

  it("passes the secondary's servedBy through on its done event after failover", async () => {
    const primary = provider({
      id: 'gemini',
      // eslint-disable-next-line require-yield
      stream: async function* () {
        throw status(503);
      },
    });
    const secondary = provider({
      id: 'groq',
      stream: async function* () {
        yield { type: 'text', delta: 'SECONDARY' };
        yield { type: 'done', stopReason: 'stop', servedBy: 'groq' };
      },
    });
    const events = await collect(new FailoverChatProvider(primary, secondary).stream(REQ));
    const done = events.find((e) => e.type === 'done');
    expect(done).toEqual({ type: 'done', stopReason: 'stop', servedBy: 'groq' });
  });

  it('propagates and does NOT splice when the primary errors AFTER a text delta', async () => {
    const secondaryStream = vi.fn();
    const primary = provider({
      stream: async function* () {
        yield { type: 'text', delta: 'PRI' };
        throw status(429);
      },
    });
    const secondary = provider({ id: 'secondary', stream: secondaryStream });

    const seen: ChatEvent[] = [];
    await expect(
      (async () => {
        for await (const ev of new FailoverChatProvider(primary, secondary).stream(REQ)) seen.push(ev);
      })(),
    ).rejects.toMatchObject({ status: 429 });

    expect(seen).toEqual([{ type: 'text', delta: 'PRI' }]);
    expect(secondaryStream).not.toHaveBeenCalled();
  });

  it('does NOT fail over a tool request to a non-tool secondary (stream)', async () => {
    const secondaryStream = vi.fn();
    const primary = provider({
      supportsTools: true,
      stream: async function* () {
        throw status(429);
      },
    });
    const secondary = provider({ id: 'secondary', supportsTools: false, stream: secondaryStream });

    await expect(collect(new FailoverChatProvider(primary, secondary).stream(TOOL_REQ))).rejects.toMatchObject({
      status: 429,
    });
    expect(secondaryStream).not.toHaveBeenCalled();
  });
});

describe('FailoverChatProvider metadata', () => {
  it('takes id from primary, contextWindow = min, supportsTools = either', () => {
    const primary = provider({ id: 'gemini', contextWindow: 1_000_000, supportsTools: true });
    const secondary = provider({ id: 'groq', contextWindow: 131_072, supportsTools: false });
    const f = new FailoverChatProvider(primary, secondary);
    expect(f.id).toBe('gemini');
    expect(f.contextWindow).toBe(131_072);
    expect(f.supportsTools).toBe(true);
  });
});
