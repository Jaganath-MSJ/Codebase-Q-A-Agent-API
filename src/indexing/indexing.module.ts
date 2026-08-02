import { Module } from '@nestjs/common';
import { WalkerModule } from '../walker/walker.module';
import { ChunkingModule } from '../chunking/chunking.module';
import { IndexingService } from './indexing.service';

@Module({
  imports: [WalkerModule, ChunkingModule],
  providers: [IndexingService],
  exports: [IndexingService],
})
export class IndexingModule {}
