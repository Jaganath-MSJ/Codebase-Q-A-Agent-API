import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import { AppModule } from './app.module';
import { installProcessBackstops } from './common/process-backstops';

// Keeps a transient failure in fire-and-forget background work from exiting the
// API. Covers both the async and the synchronous channel — see the module for
// why the pair has to be symmetric (DEF-007).
installProcessBackstops();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // gzip JSON responses. CRITICAL: never compress SSE — compression
  // buffers the response, which would stall the chat and indexing streams that
  // depend on token-by-token flushing. Everything else uses the default filter.
  app.use(
    compression({
      filter: (req, res) => {
        const contentType = res.getHeader('Content-Type');
        if (
          typeof contentType === 'string' &&
          contentType.includes('text/event-stream')
        ) {
          return false;
        }
        return compression.filter(req, res);
      },
    }),
  );

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('Codebase Q&A Agent API')
    .setVersion('0.1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
}
void bootstrap();
