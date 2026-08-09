import { Module } from '@nestjs/common';
import { LocalPathAdapter } from './local-path.adapter';
import { SourceAdapterRegistry } from './source-adapter.registry';

@Module({
  providers: [LocalPathAdapter, SourceAdapterRegistry],
  exports: [SourceAdapterRegistry],
})
export class SourcesModule {}
