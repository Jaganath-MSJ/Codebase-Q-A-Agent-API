import { Module } from '@nestjs/common';
import { WalkerModule } from '../walker/walker.module';
import { ChunkingModule } from '../chunking/chunking.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { IndexingService } from './indexing.service';

@Module({
  imports: [WalkerModule, ChunkingModule, EmbeddingsModule],
  providers: [IndexingService],
  exports: [IndexingService],
})
export class IndexingModule {}
