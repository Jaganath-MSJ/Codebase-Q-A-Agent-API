import 'dotenv/config';
import { Global, Module } from '@nestjs/common';
import { validateEnv } from './env.schema';
import { ConfigService, ENV_TOKEN } from './config.service';

@Global()
@Module({
  providers: [
    { provide: ENV_TOKEN, useValue: validateEnv(process.env) },
    ConfigService,
  ],
  exports: [ConfigService],
})
export class ConfigModule {}
