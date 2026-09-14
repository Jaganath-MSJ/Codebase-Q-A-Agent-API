import { describe, it, expect, vi, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CachingChatProvider } from './cache';
import type { ChatProvider, ChatRequest } from './chat-provider.interface';

function inner(complete: ReturnType<typeof vi.fn>): ChatProvider {
  return {
    id: 'stub',
    contextWindow: 1000,
    supportsTools: true,
    complete,

    stream: async function* () {
      throw new Error('unused');
    },
  };
}

const BASE: ChatRequest = { system: 's', user: 'u' };

describe('CachingChatProvider cache key (complete)', () => {
  const dirs: string[] = [];
  const tmp = (): string => {
    const d = path.join(
      os.tmpdir(),
      `llm-cache-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    dirs.push(d);
    return d;
  };
  afterEach(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    dirs.length = 0;
  });

  it('serves an identical request from cache (inner called once)', async () => {
    const complete = vi.fn().mockResolvedValue({ text: 'X', usage: {} });
    const p = new CachingChatProvider(inner(complete), tmp());
    await p.complete(BASE);
    await p.complete(BASE);
    expect(complete).toHaveBeenCalledOnce();
  });

  it('does NOT collide when only maxTokens differs (Phase 12.4)', async () => {
    const complete = vi.fn().mockResolvedValue({ text: 'X', usage: {} });
    const p = new CachingChatProvider(inner(complete), tmp());
    await p.complete({ ...BASE, maxTokens: 100 });
    await p.complete({ ...BASE, maxTokens: 2000 });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('a repeated capped request is still a hit (same maxTokens)', async () => {
    const complete = vi.fn().mockResolvedValue({ text: 'X', usage: {} });
    const p = new CachingChatProvider(inner(complete), tmp());
    await p.complete({ ...BASE, maxTokens: 256 });
    await p.complete({ ...BASE, maxTokens: 256 });
    expect(complete).toHaveBeenCalledOnce();
  });
});
