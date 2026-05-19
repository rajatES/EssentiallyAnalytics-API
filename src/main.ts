import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import helmet from 'helmet';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger:
      process.env.NODE_ENV === 'production'
        ? ['error', 'warn', 'log']
        : ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  // Security headers
  app.use(helmet());

  app.use(cookieParser());
  app.use(compression({ threshold: 1024 }));

  // Global validation pipe — auto-validates DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global exception filter — catches unhandled errors, hides stack traces
  app.useGlobalFilters(new AllExceptionsFilter());

  // Health check — no auth required, used by Docker HEALTHCHECK
  app.use('/health', (req: any, res: any) => {
    res.status(200).json({ status: 'ok' });
  });

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  app.enableCors({
    origin: frontendUrl === '*' ? true : frontendUrl,
    credentials: true,
  });

  const port = process.env.PORT ?? 5000;
  await app.listen(port);
  Logger.log(`Application running on port ${port}`, 'Bootstrap');
}
bootstrap();
