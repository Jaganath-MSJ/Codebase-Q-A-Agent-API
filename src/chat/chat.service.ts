import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { RetrievalService } from '../retrieval/retrieval.service';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import { ConversationsRepository } from '../db/repositories/conversations.repository';
import { MessagesRepository } from '../db/repositories/messages.repository';
import type { ConversationRow, MessageRow } from '../db/schema';
import { CHAT_PROVIDER_TOKEN } from '../llm/llm.module';
import type { ChatProvider } from '../llm/chat-provider.interface';
import { buildUserPrompt, SYSTEM_PROMPT, type EvidenceBlock } from './prompt.builder';
import { parseCitations, type Citation } from './citation.parser';

const TOP_K = 10;
const TITLE_MAX_LENGTH = 80;

export interface PostMessageResult {
  userMessage: MessageRow;
  assistantMessage: MessageRow;
  citations: Citation[];
}

@Injectable()
export class ChatService {
  constructor(
    private readonly retrievalService: RetrievalService,
    private readonly projectsRepository: ProjectsRepository,
    private readonly conversationsRepository: ConversationsRepository,
    private readonly messagesRepository: MessagesRepository,
    @Inject(CHAT_PROVIDER_TOKEN) private readonly chatProvider: ChatProvider,
  ) {}

  async createConversation(projectId: string): Promise<ConversationRow> {
    const project = await this.projectsRepository.findById(projectId);
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    return this.conversationsRepository.create({ projectId, title: null });
  }

  async listConversations(projectId: string): Promise<ConversationRow[]> {
    return this.conversationsRepository.findAllByProject(projectId);
  }

  async listMessages(conversationId: string): Promise<MessageRow[]> {
    await this.requireConversation(conversationId);
    return this.messagesRepository.findAllByConversation(conversationId);
  }

  async postMessage(conversationId: string, question: string): Promise<PostMessageResult> {
    const conversation = await this.requireConversation(conversationId);

    const scoredChunks = await this.retrievalService.search(conversation.projectId, question, TOP_K);

    const evidence: EvidenceBlock[] = scoredChunks.map((chunk) => ({
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      content: chunk.content,
    }));

    const user = buildUserPrompt(evidence, question);
    const completion = await this.chatProvider.complete({ system: SYSTEM_PROMPT, user });
    const citations = parseCitations(completion.text, evidence);

    const { userMessage, assistantMessage } = await this.messagesRepository.createTurn(
      conversationId,
      question,
      completion.text,
    );

    if (!conversation.title) {
      await this.conversationsRepository.setTitle(conversationId, question.slice(0, TITLE_MAX_LENGTH));
    }
    await this.conversationsRepository.touch(conversationId);

    return { userMessage, assistantMessage, citations };
  }

  private async requireConversation(id: string): Promise<ConversationRow> {
    const conversation = await this.conversationsRepository.findById(id);
    if (!conversation) throw new NotFoundException(`Conversation ${id} not found`);
    return conversation;
  }
}
