import { Module } from '@nestjs/common';
import { GitUrlAdapter } from './git-url.adapter';
import { LocalPathAdapter } from './local-path.adapter';
import { SourceAdapterRegistry } from './source-adapter.registry';
import { ZipUploadAdapter } from './zip-upload.adapter';

@Module({
  providers: [LocalPathAdapter, GitUrlAdapter, ZipUploadAdapter, SourceAdapterRegistry],
  exports: [SourceAdapterRegistry],
})
export class SourcesModule {}
