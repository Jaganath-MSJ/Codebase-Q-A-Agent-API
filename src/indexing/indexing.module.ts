import { Module } from '@nestjs/common';
import { WalkerModule } from '../walker/walker.module';
import { ChunkingModule } from '../chunking/chunking.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { IndexingService } from './indexing.service';
import { ProgressReporter } from './progress.reporter';
import { EmbeddingRateLimiter } from './rate-limiter';

@Module({
  imports: [WalkerModule, ChunkingModule, EmbeddingsModule],
  providers: [IndexingService, ProgressReporter, EmbeddingRateLimiter],
  exports: [IndexingService, ProgressReporter],
})
export class IndexingModule {}
