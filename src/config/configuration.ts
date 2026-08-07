import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default('7d'),
  AI_SERVICE_URL: z.string().url().default('http://localhost:4000'),
  AI_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  AI_SERVICE_API_KEY: z.string().optional().default(''),
  MAX_TASK_ITERATIONS: z.coerce.number().int().positive().default(50),
  CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_TTL_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  WS_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  STORE_SCREENSHOTS: z.preprocess(
    (v) => v === true || v === 'true',
    z.boolean(),
  ).default(false),
  SCREENSHOT_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  DEVICE_TOKEN_BYTES: z.coerce.number().int().positive().default(32),
});

export type AppConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): AppConfig {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return parsed.data;
}

export default registerAs('app', () => {
  return validateEnv(process.env as Record<string, unknown>);
});
