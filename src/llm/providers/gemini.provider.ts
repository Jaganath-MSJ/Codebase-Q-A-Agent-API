import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  Content,
  createPartFromFunctionCall,
  createPartFromFunctionResponse,
  createPartFromText,
  createUserContent,
  FinishReason,
  FunctionDeclaration,
  GoogleGenAI,
  Part,
} from '@google/genai';
import { ConfigService } from '../../config/config.service';
import type {
  ChatCompletion,
  ChatEvent,
  ChatProvider,
  ChatRequest,
  ChatStopReason,
  ToolDefinition,
} from '../chat-provider.interface';

// Pinned dated model IDs (gemini-2.5-flash, gemini-2.0-flash, ...) either 404
// for new accounts or report a hard 0 free-tier quota depending on when the
// underlying Google Cloud project was created. The rolling "-latest" alias is
// what Google's own free tier actually grants new accounts access to.
const MODEL_ID = 'gemini-flash-latest';

function toStopReason(reason: FinishReason | undefined): ChatStopReason {
  if (reason === FinishReason.MAX_TOKENS) return 'length';
  return 'stop';
}

function toFunctionDeclaration(tool: ToolDefinition): FunctionDeclaration {
  return { name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters };
}

/** `req.priorTurns` maps onto Gemini's own alternating model/user `Content` shape. */
function buildContents(req: ChatRequest): Content[] {
  const contents: Content[] = [createUserContent(req.user)];

  for (const turn of req.priorTurns ?? []) {
    if (turn.role === 'assistant') {
      const parts: Part[] = [];
      if (turn.content) parts.push(createPartFromText(turn.content));
      for (const call of turn.toolCalls) {
        const part = createPartFromFunctionCall(call.name, call.args);
        // Gemini rejects the follow-up request (400 INVALID_ARGUMENT) if a
        // function-call part from a prior turn is replayed without the
        // `thoughtSignature` it originally carried.
        if (typeof call.providerData === 'string') part.thoughtSignature = call.providerData;
        parts.push(part);
      }
      contents.push({ role: 'model', parts });
    } else {
      const parts = turn.results.map((r) =>
        createPartFromFunctionResponse(r.toolCallId, r.name, { output: r.content }),
      );
      contents.push(createUserContent(parts));
    }
  }

  return contents;
}

@Injectable()
export class GeminiChatProvider implements ChatProvider {
  readonly id = `gemini:${MODEL_ID}`;
  readonly contextWindow = 1_000_000;
  readonly supportsTools = true;

  private readonly client: GoogleGenAI;

  constructor(config: ConfigService) {
    this.client = new GoogleGenAI({ apiKey: config.googleApiKey });
  }

  async complete(req: ChatRequest, signal?: AbortSignal): Promise<ChatCompletion> {
    const response = await this.client.models.generateContent({
      model: MODEL_ID,
      contents: req.user,
      config: { systemInstruction: req.system, abortSignal: signal, maxOutputTokens: req.maxTokens },
    });

    return {
      text: response.text ?? '',
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount,
        outputTokens: response.usageMetadata?.candidatesTokenCount,
      },
    };
  }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const stream = await this.client.models.generateContentStream({
      model: MODEL_ID,
      contents: buildContents(req),
      config: {
        systemInstruction: req.system,
        abortSignal: signal,
        maxOutputTokens: req.maxTokens,
        tools: req.tools?.length ? [{ functionDeclarations: req.tools.map(toFunctionDeclaration) }] : undefined,
      },
    });

    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let stopReason: ChatStopReason = 'stop';
    const seenCalls = new Set<string>();

    for await (const chunk of stream) {
      if (chunk.text) yield { type: 'text', delta: chunk.text };

      // Read raw parts rather than the `functionCalls` convenience getter,
      // which drops `thoughtSignature` — required back on replay (see
      // `buildContents`).
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        const call = part.functionCall;
        if (!call) continue;
        // Dedupe on the call's own id/content, never on a freshly-minted
        // fallback — `call.id` is usually absent for a single, non-parallel
        // call, and a fresh `randomUUID()` per line would make the dedup a
        // no-op if the same part is ever re-emitted across chunks.
        const dedupeKey = call.id ?? `${call.name ?? ''}:${JSON.stringify(call.args ?? {})}`;
        if (seenCalls.has(dedupeKey)) continue;
        seenCalls.add(dedupeKey);
        yield {
          type: 'tool_call',
          id: call.id ?? randomUUID(),
          name: call.name ?? '',
          args: call.args ?? {},
          providerData: part.thoughtSignature,
        };
        stopReason = 'tool_use';
      }

      if (chunk.usageMetadata) {
        inputTokens = chunk.usageMetadata.promptTokenCount;
        outputTokens = chunk.usageMetadata.candidatesTokenCount;
      }
      // Gemini reports a normal STOP finish reason even when the turn ended
      // in a function call — never let it downgrade a 'tool_use' we already
      // detected above.
      const finishReason = chunk.candidates?.[0]?.finishReason;
      if (finishReason && stopReason !== 'tool_use') stopReason = toStopReason(finishReason);
    }

    yield { type: 'usage', inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
    yield { type: 'done', stopReason };
  }
}
