import { Module } from '@nestjs/common';
import { GitUrlAdapter } from './git-url.adapter';
import { LocalPathAdapter } from './local-path.adapter';
import { SourceAdapterRegistry } from './source-adapter.registry';

@Module({
  providers: [LocalPathAdapter, GitUrlAdapter, SourceAdapterRegistry],
  exports: [SourceAdapterRegistry],
})
export class SourcesModule {}
