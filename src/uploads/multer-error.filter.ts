import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { MulterError } from 'multer';

// Multer's own size-cap rejection happens inside the interceptor, before the
// controller method runs, so it never gets a chance to become a clean
// BadRequestException on its own — without this it surfaces as a bare 500.
@Catch(MulterError)
export class MulterErrorFilter implements ExceptionFilter {
  catch(error: MulterError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const mapped = new BadRequestException(
      error.code === 'LIMIT_FILE_SIZE'
        ? 'Upload exceeds the 100 MB size cap'
        : error.message,
    );
    response.status(mapped.getStatus()).json(mapped.getResponse());
  }
}
