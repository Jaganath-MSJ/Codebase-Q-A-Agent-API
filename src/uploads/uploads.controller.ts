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
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiTags,
} from '@nestjs/swagger';
import * as path from 'node:path';
import { open, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
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
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
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
  async upload(
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<UploadResultDto> {
    if (!file)
      throw new BadRequestException(
        'No file uploaded (expected multipart field "file")',
      );

    // DEF-021. The fileFilter above can only see the *name* — multer runs it
    // before any bytes are written — so until now anything at all was accepted
    // provided it ended in `.zip`. The failure then surfaced much later, as a
    // failed indexing job on a project the user had already named and created.
    //
    // Checked here instead, where the bytes exist, and the file is removed on
    // rejection so a bad upload does not linger in data/uploads as a handle
    // that can never be consumed.
    if (!(await startsWithZipSignature(file.path))) {
      await rm(file.path, { force: true });
      throw new BadRequestException(
        'That file is not a zip archive (bad signature)',
      );
    }

    return {
      uploadId: path.basename(file.filename, '.zip'),
      sizeBytes: file.size,
    };
  }
}

/**
 * The three signatures a zip file can legitimately start with:
 *
 *   PK\x03\x04  a normal archive (local file header)
 *   PK\x05\x06  an EMPTY archive (end-of-central-directory only) — a real,
 *                valid zip, which is why "is it empty?" is not the same
 *                question as "is it a zip?"
 *   PK\x07\x08  a spanned/split archive
 *
 * Only the first four bytes are read; this says nothing about whether the
 * archive is well-formed or safe to extract. The zip-slip defences in
 * `zip-extractor.ts` remain the thing that makes extraction safe, unchanged.
 */
const ZIP_SIGNATURES = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x07, 0x08]),
];

async function startsWithZipSignature(filePath: string): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, 'r');
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4), 0, 4, 0);
    if (bytesRead < 4) return false;
    return ZIP_SIGNATURES.some((signature) => buffer.equals(signature));
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}
