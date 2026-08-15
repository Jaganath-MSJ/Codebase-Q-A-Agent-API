import { Global, Inject, Module, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { ConfigService } from '../config/config.service';
import { createPool, createDb } from './pool';
import type { Db } from './pool';
import { runMigrations } from './migrate';
import { ProjectsRepository } from './repositories/projects.repository';
import { FilesRepository } from './repositories/files.repository';
import { ChunksRepository } from './repositories/chunks.repository';
import { JobsRepository } from './repositories/jobs.repository';
import { ConversationsRepository } from './repositories/conversations.repository';
import { MessagesRepository } from './repositories/messages.repository';
import { CitationsRepository } from './repositories/citations.repository';
import { CredentialsRepository } from './repositories/credentials.repository';
import { DB_TOKEN, PG_POOL_TOKEN } from './tokens';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createPool(config.databaseUrl),
    },
    {
      provide: DB_TOKEN,
      inject: [PG_POOL_TOKEN],
      useFactory: (pool: Pool) => createDb(pool),
    },
    ProjectsRepository,
    FilesRepository,
    ChunksRepository,
    JobsRepository,
    ConversationsRepository,
    MessagesRepository,
    CitationsRepository,
    CredentialsRepository,
  ],
  exports: [
    DB_TOKEN,
    ProjectsRepository,
    FilesRepository,
    ChunksRepository,
    JobsRepository,
    ConversationsRepository,
    MessagesRepository,
    CitationsRepository,
    CredentialsRepository,
  ],
})
export class DbModule implements OnModuleInit {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async onModuleInit(): Promise<void> {
    await runMigrations(this.db);
  }
}
