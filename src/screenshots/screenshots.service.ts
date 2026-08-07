import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../common/redis/redis.module';
import type { AppConfig } from '../config/configuration';
import type { ScreenResultPayload } from '../common/events/ws-events';

/**
 * Ephemeral screenshot buffer.
 * Screenshots are NOT permanently stored unless STORE_SCREENSHOTS=true.
 */
@Injectable()
export class ScreenshotsService {
  private readonly logger = new Logger(ScreenshotsService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  private key(requestId: string): string {
    return `screenshot:${requestId}`;
  }

  async storeEphemeral(payload: ScreenResultPayload): Promise<void> {
    const app = this.config.get<AppConfig>('app')!;
    const ttl = app.SCREENSHOT_TTL_SECONDS;

    await this.redis.setJson(this.key(payload.requestId), payload, ttl);

    if (app.STORE_SCREENSHOTS) {
      this.logger.warn(
        `STORE_SCREENSHOTS enabled — screenshot ${payload.requestId} retained for ${ttl}s (still not written to Postgres)`,
      );
    }
  }

  async get(requestId: string): Promise<ScreenResultPayload | null> {
    return this.redis.getJson<ScreenResultPayload>(this.key(requestId));
  }

  async consume(requestId: string): Promise<ScreenResultPayload | null> {
    const data = await this.get(requestId);
    if (data) {
      await this.redis.del(this.key(requestId));
    }
    return data;
  }

  async discard(requestId: string): Promise<void> {
    await this.redis.del(this.key(requestId));
  }
}
