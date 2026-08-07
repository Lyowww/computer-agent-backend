import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './common/redis/redis.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { JwtAuthGuard } from './common/guards/auth.guards';
import { HttpThrottlerGuard } from './common/guards/http-throttler.guard';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { DevicesModule } from './devices/devices.module';
import { SessionsModule } from './sessions/sessions.module';
import { TasksModule } from './tasks/tasks.module';
import { AiModule } from './ai/ai.module';
import { ActionsModule } from './actions/actions.module';
import { ScreenshotsModule } from './screenshots/screenshots.module';
import { WebsocketModule } from './websocket/websocket.module';
import { ChatModule } from './chat/chat.module';
import type { AppConfig } from './config/configuration';
import { HealthController } from './health.controller';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    RedisModule,
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const app = config.get<AppConfig>('app')!;
        return [
          {
            ttl: app.RATE_LIMIT_TTL_MS,
            limit: app.RATE_LIMIT_MAX,
          },
        ];
      },
    }),
    AuthModule,
    UsersModule,
    DevicesModule,
    SessionsModule,
    ActionsModule,
    ScreenshotsModule,
    AiModule,
    TasksModule,
    WebsocketModule,
    ChatModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: HttpThrottlerGuard },
  ],
})
export class AppModule {}
