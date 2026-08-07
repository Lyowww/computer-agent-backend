import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  loginSchema,
  createDeviceSchema,
  createTaskSchema,
  validatedActionSchema,
} from '../src/common/validation/schemas';
import { validateEnv } from '../src/config/configuration';

describe('App bootstrap contracts (e2e-lite)', () => {
  it('validates required env shape', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'super-secret-key-32chars-min!!',
      AI_SERVICE_URL: 'http://localhost:4000',
      PORT: '3000',
    });
    expect(env.PORT).toBe(3000);
    expect(env.STORE_SCREENSHOTS).toBe(false);
  });

  it('rejects short JWT secrets', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        JWT_SECRET: 'short',
      }),
    ).toThrow(/Invalid environment/);
  });

  it('REST DTO schemas match API contract', () => {
    expect(loginSchema.parse({ email: 'a@b.com', password: 'password1' }).email).toBe(
      'a@b.com',
    );
    expect(
      createDeviceSchema.parse({ name: 'Mac', os: 'darwin' }).os,
    ).toBe('darwin');
    expect(
      createTaskSchema.parse({
        instruction: 'Open Slack',
        deviceId: '11111111-1111-1111-1111-111111111111',
      }).instruction,
    ).toBe('Open Slack');
    expect(
      validatedActionSchema.parse({ type: 'KEY', params: { key: 'Enter' } }).type,
    ).toBe('KEY');
  });

  it('can create a testing module shell', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            () => ({
              app: validateEnv({
                DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
                REDIS_URL: 'redis://localhost:6379',
                JWT_SECRET: 'super-secret-key-32chars-min!!',
                AI_SERVICE_URL: 'http://localhost:4000',
              }),
            }),
          ],
        }),
      ],
    }).compile();

    const app: INestApplication = module.createNestApplication();
    await app.init();
    await app.close();
  });
});
