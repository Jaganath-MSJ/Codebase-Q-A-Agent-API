import { Module } from '@nestjs/common';
import { CredentialsModule } from '../credentials/credentials.module';
import { GitPrivateAdapter } from './git-private.adapter';
import { GitUrlAdapter } from './git-url.adapter';
import { LocalPathAdapter } from './local-path.adapter';
import { SourceAdapterRegistry } from './source-adapter.registry';
import { ZipUploadAdapter } from './zip-upload.adapter';

@Module({
  imports: [CredentialsModule],
  providers: [
    LocalPathAdapter,
    GitUrlAdapter,
    ZipUploadAdapter,
    GitPrivateAdapter,
    SourceAdapterRegistry,
  ],
  exports: [SourceAdapterRegistry],
})
export class SourcesModule {}
