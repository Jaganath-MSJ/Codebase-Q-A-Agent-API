import { Module } from '@nestjs/common';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { VectorRetriever } from './vector.retriever';
import { RetrievalService } from './retrieval.service';
import { SearchController } from './search.controller';

@Module({
  imports: [EmbeddingsModule],
  controllers: [SearchController],
  providers: [VectorRetriever, RetrievalService],
})
export class RetrievalModule {}
