import { Module } from '@nestjs/common';
import { WalkerModule } from '../walker/walker.module';
import { ChunkingModule } from '../chunking/chunking.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { IndexingService } from './indexing.service';
import { ProgressReporter } from './progress.reporter';

@Module({
  imports: [WalkerModule, ChunkingModule, EmbeddingsModule],
  providers: [IndexingService, ProgressReporter],
  exports: [IndexingService, ProgressReporter],
})
export class IndexingModule {}
