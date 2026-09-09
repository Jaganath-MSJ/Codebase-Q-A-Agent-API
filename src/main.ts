import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import { AppModule } from './app.module';

// Backstop for fire-and-forget background work (the setInterval pollers in
// jobs/). Every such caller is expected to catch its own errors, but a missed
// one would otherwise crash the whole API on a transient DB blip. Log and keep
// the process alive rather than exiting on Node's default.
const processLogger = new Logger('Process');
process.on('unhandledRejection', (reason) => {
  processLogger.error(`Unhandled promise rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // gzip JSON responses (Phase 12.15). CRITICAL: never compress SSE — compression
  // buffers the response, which would stall the chat and indexing streams that
  // depend on token-by-token flushing. Everything else uses the default filter.
  app.use(
    compression({
      filter: (req, res) => {
        const contentType = res.getHeader('Content-Type');
        if (typeof contentType === 'string' && contentType.includes('text/event-stream')) {
          return false;
        }
        return compression.filter(req, res);
      },
    }),
  );

  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const config = new DocumentBuilder()
    .setTitle('Codebase Q&A Agent API')
    .setVersion('0.1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
}
bootstrap();
