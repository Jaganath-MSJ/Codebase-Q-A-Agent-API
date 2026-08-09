import { Injectable } from '@nestjs/common';
import { LocalPathAdapter } from './local-path.adapter';
import type { SourceAdapter } from './source-adapter.interface';

@Injectable()
export class SourceAdapterRegistry {
  constructor(private readonly localPathAdapter: LocalPathAdapter) {}

  getAdapter(kind: string): SourceAdapter {
    if (kind === 'local_path') return this.localPathAdapter;
    throw new Error(`Source kind '${kind}' is not implemented yet.`);
  }
}
