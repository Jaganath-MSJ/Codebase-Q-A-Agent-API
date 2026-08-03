import { EventEmitter } from 'node:events';
import { Module } from '@nestjs/common';
import { IndexingModule } from '../indexing/indexing.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { WorkerService } from './worker.service';
import { JOB_EVENTS_TOKEN } from './job-events';

@Module({
  imports: [IndexingModule],
  controllers: [JobsController],
  providers: [
    JobsService,
    WorkerService,
    { provide: JOB_EVENTS_TOKEN, useValue: new EventEmitter() },
  ],
  exports: [JobsService],
})
export class JobsModule {}
