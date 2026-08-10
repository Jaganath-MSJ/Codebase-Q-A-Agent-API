import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { TourModule } from '../tour/tour.module';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  imports: [JobsModule, TourModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
})
export class ProjectsModule {}
