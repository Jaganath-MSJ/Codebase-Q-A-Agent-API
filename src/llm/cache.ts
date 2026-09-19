import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { sha256 } from '../common/hash';
import type {
  ChatCompletion,
  ChatEvent,
  ChatProvider,
  ChatRequest,
  ChatStopReason,
  ChatUsage,
  ToolCall,
} from './chat-provider.interface';

interface CachedStream {
  text: string;
  usage: ChatUsage;
  toolCalls: ToolCall[];
  stopReason: ChatStopReason;
  // The provider that actually served the original stream — preserved so a
  // cache replay reports the same provenance. Optional: entries written before
  // this field existed replay with it undefined.
  servedBy?: string;
}

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

  async complete(
    req: ChatRequest,
    signal?: AbortSignal,
  ): Promise<ChatCompletion> {
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

  async *stream(
    req: ChatRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ChatEvent> {
    const cachePath = this.cachePath(req);

    try {
      const cached = JSON.parse(
        await readFile(cachePath, 'utf8'),
      ) as CachedStream;
      if (cached.text) yield { type: 'text', delta: cached.text };
      for (const call of cached.toolCalls) yield { type: 'tool_call', ...call };
      yield {
        type: 'usage',
        inputTokens: cached.usage.inputTokens ?? 0,
        outputTokens: cached.usage.outputTokens ?? 0,
      };
      yield {
        type: 'done',
        stopReason: cached.stopReason,
        servedBy: cached.servedBy,
      };
      return;
    } catch {
      // cache miss
    }

    let text = '';
    let usage: ChatUsage = {};
    const toolCalls: ToolCall[] = [];
    let stopReason: ChatStopReason = 'stop';
    let servedBy: string | undefined;

    for await (const event of this.inner.stream(req, signal)) {
      if (event.type === 'text') text += event.delta;
      if (event.type === 'tool_call') {
        toolCalls.push({
          id: event.id,
          name: event.name,
          args: event.args,
          providerData: event.providerData,
        });
      }
      if (event.type === 'usage')
        usage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
        };
      if (event.type === 'done') {
        stopReason = event.stopReason;
        servedBy = event.servedBy;
      }
      yield event;
    }

    if (!signal?.aborted) {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(
        cachePath,
        JSON.stringify({
          text,
          usage,
          toolCalls,
          stopReason,
          servedBy,
        } satisfies CachedStream),
      );
    }
  }

  // Includes `tools`/`priorTurns` so every step of an agent loop — which
  // shares the same top-level system+user but differs in what happened
  // since — gets its own cache entry. `maxTokens` is part of the key too:
  // two otherwise-identical requests with different output caps can produce
  // different (truncated) results, so they must not collide.
  private cachePath(req: ChatRequest): string {
    const key = sha256(
      `${this.id}\x00${req.system}\x00${req.user}\x00${JSON.stringify(req.tools ?? null)}\x00${JSON.stringify(req.priorTurns ?? null)}\x00${req.maxTokens ?? ''}`,
    );
    return path.join(this.cacheDir, `${key}.json`);
  }
}
