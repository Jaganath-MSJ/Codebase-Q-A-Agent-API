import { Module } from '@nestjs/common';
import { RepoOverviewService } from './repo-overview.service';

@Module({
  providers: [RepoOverviewService],
  exports: [RepoOverviewService],
})
export class OverviewModule {}
