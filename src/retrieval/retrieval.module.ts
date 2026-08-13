import { Module } from '@nestjs/common';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { VectorRetriever } from './vector.retriever';
import { FtsRetriever } from './fts.retriever';
import { TrigramRetriever } from './trigram.retriever';
import { HybridRetriever } from './hybrid.retriever';
import { RetrievalService } from './retrieval.service';
import { SearchController } from './search.controller';

@Module({
  imports: [EmbeddingsModule],
  controllers: [SearchController],
  providers: [VectorRetriever, FtsRetriever, TrigramRetriever, HybridRetriever, RetrievalService],
  exports: [RetrievalService],
})
export class RetrievalModule {}
