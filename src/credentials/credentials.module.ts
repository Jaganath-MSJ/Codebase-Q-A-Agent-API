import { Module } from '@nestjs/common';
import { CredentialsService } from './credentials.service';

@Module({
  providers: [CredentialsService],
  exports: [CredentialsService],
})
export class CredentialsModule {}
