import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { diskStorage } from 'multer';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '../config/config.service';
import { MAX_UPLOAD_BYTES } from './uploads.constants';
import { UploadsController } from './uploads.controller';

@Module({
  imports: [
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const uploadsDir = path.join(config.dataDir, 'uploads');
        mkdirSync(uploadsDir, { recursive: true });
        return {
          // diskStorage streams the request body straight to a file handle —
          // the request is never buffered whole in memory, which matters
          // since this accepts uploads up to the size cap below.
          storage: diskStorage({
            destination: uploadsDir,
            filename: (_req, _file, cb) => cb(null, `${randomUUID()}.zip`),
          }),
          limits: { fileSize: MAX_UPLOAD_BYTES },
        };
      },
    }),
  ],
  controllers: [UploadsController],
})
export class UploadsModule {}
