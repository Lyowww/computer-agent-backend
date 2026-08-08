import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(128),
});

export const registerSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(120).optional(),
});

export const createDeviceSchema = z.object({
  name: z.string().min(1).max(120),
  os: z.enum(['darwin', 'win32', 'linux']),
});

export const createTaskSchema = z.object({
  instruction: z.string().min(1).max(4000),
  deviceId: z.string().uuid(),
  maxIterations: z.number().int().min(1).max(200).optional(),
});

export const registerDeviceWsSchema = z.object({
  deviceToken: z.string().min(16).max(256),
  deviceName: z.string().min(1).max(120),
  os: z.enum(['darwin', 'win32', 'linux']),
});

export const captureScreenSchema = z.object({
  requestId: z.string().min(1).max(64),
  quality: z.number().int().min(1).max(100).optional(),
  taskId: z.string().uuid().optional(),
  deviceId: z.string().uuid().optional(),
});

export const userMessageSchema = z.object({
  requestId: z.string().min(1).max(64).optional(),
  taskId: z.string().uuid().optional(),
  content: z.string().min(1).max(4000),
  deviceId: z.string().uuid().optional(),
  useAi: z.boolean().optional().default(true),
});

export const notifySchema = z.object({
  requestId: z.string().min(1).max(64),
  title: z.string().max(200).optional(),
  body: z.string().min(1).max(4000),
  deviceId: z.string().uuid().optional(),
  from: z.string().max(200).optional(),
});

export const listQuerySchema = z.object({
  requestId: z.string().min(1).max(64),
  deviceId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const processesResultSchema = z.object({
  requestId: z.string().min(1).max(64),
  processes: z
    .array(
      z.object({
        pid: z.number().int().nonnegative(),
        name: z.string().min(1).max(256),
        cpu: z.number().optional(),
      }),
    )
    .max(100),
  error: z.string().max(2000).optional(),
});

export const appsResultSchema = z.object({
  requestId: z.string().min(1).max(64),
  apps: z
    .array(
      z.object({
        name: z.string().min(1).max(256),
        path: z.string().max(1024).optional(),
        running: z.boolean(),
      }),
    )
    .max(100),
  error: z.string().max(2000).optional(),
});

export const notifyResultSchema = z.object({
  requestId: z.string().min(1).max(64),
  success: z.boolean(),
  delivered: z.boolean().optional(),
  error: z.string().max(2000).optional(),
});

export const appActionSchema = z.object({
  requestId: z.string().min(1).max(64),
  app: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 _.'()-]*$/, 'Invalid application name'),
  deviceId: z.string().uuid().optional(),
});

export const appActionResultSchema = z.object({
  requestId: z.string().min(1).max(64),
  action: z.enum(['open', 'close']),
  app: z.string().min(1).max(256),
  success: z.boolean(),
  error: z.string().max(2000).optional(),
});

export const lockActionSchema = z.object({
  requestId: z.string().min(1).max(64),
  deviceId: z.string().uuid().optional(),
});

export const lockResultSchema = z.object({
  requestId: z.string().min(1).max(64),
  action: z.enum(['lock', 'unlock']),
  success: z.boolean(),
  alreadyUnlocked: z.boolean().optional(),
  error: z.string().max(2000).optional(),
});

export const pingSchema = z.object({
  requestId: z.string().min(1).max(64).optional(),
  nonce: z.string().min(8).max(128).optional(),
});

export const screenResultSchema = z
  .object({
    requestId: z.string().min(1).max(64),
    taskId: z.string().uuid().optional(),
    width: z.number().int().nonnegative().max(10000).optional(),
    height: z.number().int().nonnegative().max(10000).optional(),
    image: z.string().max(15_000_000).optional(),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
    error: z.string().max(2000).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.error) return;
    if (
      !val.image ||
      val.width == null ||
      val.height == null ||
      val.width < 1 ||
      val.height < 1
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'image, width, and height are required unless error is set',
      });
    }
  });

export const actionTypeSchema = z.enum([
  'CLICK',
  'DOUBLE_CLICK',
  'RIGHT_CLICK',
  'TYPE',
  'KEY',
  'SCROLL',
  'MOVE',
  'DRAG',
  'WAIT',
  'LOCK_SCREEN',
  'UNLOCK_SCREEN',
  'DONE',
  'FAIL',
]);

/** Never accept shell / exec / open-url arbitrary commands */
const forbiddenActionKeys = [
  'command',
  'shell',
  'exec',
  'script',
  'powershell',
  'bash',
  'cmd',
];

export const actionParamsSchema = z
  .record(z.unknown())
  .superRefine((params, ctx) => {
    for (const key of Object.keys(params)) {
      if (forbiddenActionKeys.includes(key.toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Forbidden action parameter: ${key}`,
        });
      }
    }
  });

export const validatedActionSchema = z.object({
  type: actionTypeSchema,
  params: actionParamsSchema.default({}),
  reason: z.string().max(1000).optional(),
});

export const aiServiceResponseSchema = z.object({
  taskId: z.string(),
  status: z.enum(['continue', 'completed', 'failed', 'need_user']).optional(),
  message: z.string().max(8000).optional(),
  actions: z.array(validatedActionSchema).max(20).default([]),
});

export const executeActionSchema = z.object({
  actionId: z.string().min(1).max(64),
  taskId: z.string().uuid(),
  type: actionTypeSchema,
  params: actionParamsSchema,
});

export const actionResultSchema = z.object({
  actionId: z.string().min(1).max(64),
  taskId: z.string().uuid(),
  success: z.boolean(),
  result: z.record(z.unknown()).optional(),
  error: z.string().max(2000).optional(),
});

export type LoginDto = z.infer<typeof loginSchema>;
export type RegisterDto = z.infer<typeof registerSchema>;
export type CreateDeviceDto = z.infer<typeof createDeviceSchema>;
export type CreateTaskDto = z.infer<typeof createTaskSchema>;
export type ValidatedAction = z.infer<typeof validatedActionSchema>;
export type AiServiceResponse = z.infer<typeof aiServiceResponseSchema>;
