import { Module } from '@nestjs/common';
import { IndexingModule } from '../indexing/indexing.module';
import { CredentialsModule } from '../credentials/credentials.module';
import { JobsController } from './jobs.controller';
import { ProgressController } from './progress.controller';
import { JobsService } from './jobs.service';
import { WorkerService } from './worker.service';
import { WatcherService } from './watcher.service';
import { GitPollService } from './git-poll.service';

@Module({
  imports: [IndexingModule, CredentialsModule],
  controllers: [JobsController, ProgressController],
  providers: [JobsService, WorkerService, WatcherService, GitPollService],
  exports: [JobsService],
})
export class JobsModule {}
