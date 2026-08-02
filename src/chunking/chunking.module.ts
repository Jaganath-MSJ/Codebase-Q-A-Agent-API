import { Module } from '@nestjs/common';
import { LineWindowChunker } from './line-window.chunker';

export const CHUNKER_TOKEN = Symbol('CHUNKER');

@Module({
  providers: [{ provide: CHUNKER_TOKEN, useClass: LineWindowChunker }],
  exports: [CHUNKER_TOKEN],
})
export class ChunkingModule {}
