import { Module } from '@nestjs/common';
import { createTreeSitterChunker } from './grammar-loader';

export const CHUNKER_TOKEN = Symbol('CHUNKER');

@Module({
  providers: [{ provide: CHUNKER_TOKEN, useFactory: createTreeSitterChunker }],
  exports: [CHUNKER_TOKEN],
})
export class ChunkingModule {}
