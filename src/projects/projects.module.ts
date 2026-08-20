import { Module } from '@nestjs/common';
import { CredentialsModule } from '../credentials/credentials.module';
import { JobsModule } from '../jobs/jobs.module';
import { TourModule } from '../tour/tour.module';
import { ChangeAnalysisModule } from '../change-analysis/change-analysis.module';
import { IndexingModule } from '../indexing/indexing.module';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  imports: [JobsModule, TourModule, ChangeAnalysisModule, IndexingModule, CredentialsModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
})
export class ProjectsModule {}
