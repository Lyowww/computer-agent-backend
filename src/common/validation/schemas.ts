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
});

export const screenResultSchema = z.object({
  requestId: z.string().min(1).max(64),
  taskId: z.string().uuid().optional(),
  width: z.number().int().positive().max(10000),
  height: z.number().int().positive().max(10000),
  image: z.string().min(1).max(15_000_000),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
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

export const userMessageSchema = z.object({
  requestId: z.string().min(1).max(64).optional(),
  taskId: z.string().uuid().optional(),
  content: z.string().min(1).max(4000),
  deviceId: z.string().uuid().optional(),
});

export const pingSchema = z.object({
  requestId: z.string().min(1).max(64).optional(),
  nonce: z.string().min(8).max(128).optional(),
});

export type LoginDto = z.infer<typeof loginSchema>;
export type RegisterDto = z.infer<typeof registerSchema>;
export type CreateDeviceDto = z.infer<typeof createDeviceSchema>;
export type CreateTaskDto = z.infer<typeof createTaskSchema>;
export type ValidatedAction = z.infer<typeof validatedActionSchema>;
export type AiServiceResponse = z.infer<typeof aiServiceResponseSchema>;
