import { Module } from '@nestjs/common';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { ToolRegistry } from './tool.registry';

@Module({
  imports: [RetrievalModule],
  providers: [ToolRegistry],
  exports: [ToolRegistry],
})
export class ToolsModule {}
