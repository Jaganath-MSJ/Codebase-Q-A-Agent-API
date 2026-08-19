import { Module } from '@nestjs/common';
import { IndexingModule } from '../indexing/indexing.module';
import { JobsController } from './jobs.controller';
import { ProgressController } from './progress.controller';
import { JobsService } from './jobs.service';
import { WorkerService } from './worker.service';
import { WatcherService } from './watcher.service';

@Module({
  imports: [IndexingModule],
  controllers: [JobsController, ProgressController],
  providers: [JobsService, WorkerService, WatcherService],
  exports: [JobsService],
})
export class JobsModule {}
