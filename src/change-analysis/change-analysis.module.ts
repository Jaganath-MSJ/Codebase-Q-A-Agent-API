import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { ChangeAnalysisController } from './change-analysis.controller';
import { ChangeAnalysisService } from './change-analysis.service';

@Module({
  imports: [LlmModule, RetrievalModule],
  controllers: [ChangeAnalysisController],
  providers: [ChangeAnalysisService],
  exports: [ChangeAnalysisService],
})
export class ChangeAnalysisModule {}
