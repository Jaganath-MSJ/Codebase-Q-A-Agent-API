// yazl ships no types of its own; this file exists solely to let
// zip-extractor.spec.ts craft attack/legitimate zip fixtures in-memory
// (yauzl, the extraction side actually used in production code, is typed via
// @types/yauzl).
declare module 'yazl' {
  import type { Readable } from 'node:stream';

  export interface YazlEntryOptions {
    mtime?: Date;
    mode?: number;
    compress?: boolean;
  }

  export class ZipFile {
    outputStream: Readable;
    addBuffer(
      buffer: Buffer,
      metadataPath: string,
      options?: YazlEntryOptions,
    ): void;
    addEmptyDirectory(metadataPath: string, options?: YazlEntryOptions): void;
    end(): void;
  }
}
