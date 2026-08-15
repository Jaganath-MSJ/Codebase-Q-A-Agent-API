import { Injectable } from '@nestjs/common';
import { GitPrivateAdapter } from './git-private.adapter';
import { GitUrlAdapter } from './git-url.adapter';
import { LocalPathAdapter } from './local-path.adapter';
import type { SourceAdapter } from './source-adapter.interface';
import { ZipUploadAdapter } from './zip-upload.adapter';

@Injectable()
export class SourceAdapterRegistry {
  constructor(
    private readonly localPathAdapter: LocalPathAdapter,
    private readonly gitUrlAdapter: GitUrlAdapter,
    private readonly zipUploadAdapter: ZipUploadAdapter,
    private readonly gitPrivateAdapter: GitPrivateAdapter,
  ) {}

  getAdapter(kind: string): SourceAdapter {
    if (kind === 'local_path') return this.localPathAdapter;
    if (kind === 'git_url') return this.gitUrlAdapter;
    if (kind === 'zip_upload') return this.zipUploadAdapter;
    if (kind === 'git_private') return this.gitPrivateAdapter;
    throw new Error(`Source kind '${kind}' is not implemented yet.`);
  }
}
