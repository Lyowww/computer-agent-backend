import { Controller, Get } from '@nestjs/common';
import { Public } from './common/guards/auth.guards';
import { PrismaService } from './database/prisma.service';
import { RedisService } from './common/redis/redis.module';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get()
  async check() {
    let database = 'ok';
    let redis = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'error';
    }
    try {
      await this.redis.getClient().ping();
    } catch {
      redis = 'error';
    }
    const healthy = database === 'ok' && redis === 'ok';
    return {
      status: healthy ? 'ok' : 'degraded',
      database,
      redis,
      timestamp: new Date().toISOString(),
    };
  }
}
