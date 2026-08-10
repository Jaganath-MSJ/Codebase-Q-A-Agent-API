import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { TourController } from './tour.controller';
import { TourService } from './tour.service';

@Module({
  imports: [LlmModule],
  controllers: [TourController],
  providers: [TourService],
  exports: [TourService],
})
export class TourModule {}
