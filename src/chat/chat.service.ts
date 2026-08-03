import { Inject, Injectable } from '@nestjs/common';
import { RetrievalService } from '../retrieval/retrieval.service';
import { CHAT_PROVIDER_TOKEN } from '../llm/llm.module';
import type { ChatProvider } from '../llm/chat-provider.interface';
import { buildUserPrompt, SYSTEM_PROMPT, type EvidenceBlock } from './prompt.builder';
import { parseCitations, type Citation } from './citation.parser';

const TOP_K = 10;

export interface AskResult {
  answer: string;
  citations: Citation[];
}

@Injectable()
export class ChatService {
  constructor(
    private readonly retrievalService: RetrievalService,
    @Inject(CHAT_PROVIDER_TOKEN) private readonly chatProvider: ChatProvider,
  ) {}

  async ask(projectId: string, question: string): Promise<AskResult> {
    const scoredChunks = await this.retrievalService.search(projectId, question, TOP_K);

    const evidence: EvidenceBlock[] = scoredChunks.map((chunk) => ({
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      content: chunk.content,
    }));

    const user = buildUserPrompt(evidence, question);
    const completion = await this.chatProvider.complete({ system: SYSTEM_PROMPT, user });
    const citations = parseCitations(completion.text, evidence);

    return { answer: completion.text, citations };
  }
}
