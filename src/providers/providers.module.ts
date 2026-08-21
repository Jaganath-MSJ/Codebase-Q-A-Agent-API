import { Module } from '@nestjs/common';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { LlmModule } from '../llm/llm.module';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';

@Module({
  imports: [EmbeddingsModule, LlmModule],
  controllers: [ProvidersController],
  providers: [ProvidersService],
})
export class ProvidersModule {}
