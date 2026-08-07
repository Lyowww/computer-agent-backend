import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { AppConfig } from '../../config/configuration';
import { PendingStore } from '../pending/pending.store';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  getClient(): Redis {
    return this.client;
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds && ttlSeconds > 0) {
      await this.client.set(key, value, 'EX', ttlSeconds);
      return;
    }
    await this.client.set(key, value);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /** Simple sliding-window rate limit: returns true if allowed. Fail-open if Redis is slow/down. */
  async checkRateLimit(
    key: string,
    max: number,
    windowMs: number,
  ): Promise<boolean> {
    try {
      const now = Date.now();
      const windowKey = `rl:${key}`;
      const multi = this.client.multi();
      multi.zremrangebyscore(windowKey, 0, now - windowMs);
      multi.zadd(windowKey, now, `${now}-${Math.random()}`);
      multi.zcard(windowKey);
      multi.pexpire(windowKey, windowMs);
      const results = await Promise.race([
        multi.exec(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
      ]);
      if (!results) {
        this.logger.warn('Redis rate-limit timed out; allowing request');
        return true;
      }
      const count = (results?.[2]?.[1] as number) ?? 0;
      return count <= max;
    } catch (error) {
      this.logger.warn(
        `Redis rate-limit failed; allowing request (${error instanceof Error ? error.message : error})`,
      );
      return true;
    }
  }

  /** Replay protection: set nonce if not seen; returns false if replay */
  async claimNonce(nonce: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(
      `nonce:${nonce}`,
      '1',
      'EX',
      ttlSeconds,
      'NX',
    );
    return result === 'OK';
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
    this.logger.log('Redis connection closed');
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const app = config.get<AppConfig>('app')!;
        const client = new Redis(app.REDIS_URL, {
          maxRetriesPerRequest: 2,
          connectTimeout: 5000,
          commandTimeout: 3000,
          lazyConnect: false,
          enableOfflineQueue: false,
        });
        client.on('error', (err) => {
          Logger.error(`Redis error: ${err.message}`, undefined, 'Redis');
        });
        return client;
      },
    },
    RedisService,
    PendingStore,
  ],
  exports: [RedisService, REDIS_CLIENT, PendingStore],
})
export class RedisModule {}
