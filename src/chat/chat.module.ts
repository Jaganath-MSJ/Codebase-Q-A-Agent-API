import { Module } from '@nestjs/common';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { LlmModule } from '../llm/llm.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

@Module({
  imports: [RetrievalModule, LlmModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
