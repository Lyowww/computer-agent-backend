import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';
import type { AppConfig } from './config/configuration';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });

  app.use(helmet());
  app.enableCors({
    origin: true,
    credentials: true,
  });
  app.setGlobalPrefix('api');

  const config = app.get(ConfigService);
  const appConfig = config.get<AppConfig>('app')!;
  const port = appConfig.PORT;

  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Computer Agent Backend listening on http://localhost:${port}`);
  // eslint-disable-next-line no-console
  console.log(`WebSocket endpoint: ws://localhost:${port}/ws`);
}

void bootstrap();
