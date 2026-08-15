import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import * as path from 'node:path';
import { UploadResultDto } from '../contracts';
import { MulterErrorFilter } from './multer-error.filter';

@ApiTags('uploads')
@Controller('uploads')
export class UploadsController {
  /**
   * Streams the multipart body straight to `data/uploads/<uploadId>.zip`
   * (see UploadsModule's diskStorage config) — validated here, but not
   * extracted. Extraction (with the zip-slip checks) happens inside
   * ZipUploadAdapter.materialize(), the first time the resulting project is
   * indexed, where it can report progress and be canceled like any other
   * indexing job.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiCreatedResponse({ type: UploadResultDto })
  @UseFilters(MulterErrorFilter)
  @UseInterceptors(
    FileInterceptor('file', {
      fileFilter: (_req, file, cb) => {
        if (!file.originalname.toLowerCase().endsWith('.zip')) {
          cb(new BadRequestException('Only .zip uploads are accepted'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  upload(@UploadedFile() file?: Express.Multer.File): UploadResultDto {
    if (!file) throw new BadRequestException('No file uploaded (expected multipart field "file")');
    return { uploadId: path.basename(file.filename, '.zip'), sizeBytes: file.size };
  }
}
