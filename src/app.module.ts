import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { EventsModule } from './events/events.module';
import { ProjectsModule } from './projects/projects.module';
import { RetrievalModule } from './retrieval/retrieval.module';
import { ChatModule } from './chat/chat.module';

@Module({
  imports: [ConfigModule, DbModule, EventsModule, ProjectsModule, RetrievalModule, ChatModule],
})
export class AppModule {}
