import { Module } from '@nestjs/common';
import { WalkerService } from './walker.service';

@Module({
  providers: [WalkerService],
  exports: [WalkerService],
})
export class WalkerModule {}
