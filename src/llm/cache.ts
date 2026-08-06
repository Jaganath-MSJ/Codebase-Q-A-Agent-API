import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { sha256 } from '../common/hash';
import type { ChatCompletion, ChatEvent, ChatProvider, ChatRequest, ChatUsage } from './chat-provider.interface';

export class CachingChatProvider implements ChatProvider {
  readonly id: string;
  readonly contextWindow: number;
  readonly supportsTools: boolean;

  constructor(
    private readonly inner: ChatProvider,
    private readonly cacheDir: string,
  ) {
    this.id = inner.id;
    this.contextWindow = inner.contextWindow;
    this.supportsTools = inner.supportsTools;
  }

  async complete(req: ChatRequest, signal?: AbortSignal): Promise<ChatCompletion> {
    const cachePath = this.cachePath(req);

    try {
      const cached = await readFile(cachePath, 'utf8');
      return JSON.parse(cached) as ChatCompletion;
    } catch {
      // cache miss
    }

    const result = await this.inner.complete(req, signal);
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(cachePath, JSON.stringify(result));
    return result;
  }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const cachePath = this.cachePath(req);

    try {
      const cached = await readFile(cachePath, 'utf8');
      const result = JSON.parse(cached) as ChatCompletion;
      if (result.text) yield { type: 'text', delta: result.text };
      yield {
        type: 'usage',
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
      };
      yield { type: 'done', stopReason: 'stop' };
      return;
    } catch {
      // cache miss
    }

    let text = '';
    let usage: ChatUsage = {};
    for await (const event of this.inner.stream(req, signal)) {
      if (event.type === 'text') text += event.delta;
      if (event.type === 'usage') usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
      yield event;
    }

    if (!signal?.aborted) {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(cachePath, JSON.stringify({ text, usage } satisfies ChatCompletion));
    }
  }

  private cachePath(req: ChatRequest): string {
    const key = sha256(`${this.id}\x00${req.system}\x00${req.user}`);
    return path.join(this.cacheDir, `${key}.json`);
  }
}
