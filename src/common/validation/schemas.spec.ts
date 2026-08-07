import {
  validatedActionSchema,
  aiServiceResponseSchema,
  createTaskSchema,
  registerDeviceWsSchema,
  actionParamsSchema,
} from './schemas';

describe('validation schemas', () => {
  it('accepts valid actions', () => {
    const result = validatedActionSchema.parse({
      type: 'CLICK',
      params: { x: 10, y: 20 },
    });
    expect(result.type).toBe('CLICK');
  });

  it('rejects shell-like params', () => {
    const result = actionParamsSchema.safeParse({
      command: 'rm -rf /',
      x: 1,
    });
    expect(result.success).toBe(false);
  });

  it('validates AI response', () => {
    const parsed = aiServiceResponseSchema.parse({
      taskId: 't1',
      status: 'continue',
      message: 'Clicking button',
      actions: [{ type: 'CLICK', params: { x: 100, y: 200 } }],
    });
    expect(parsed.actions).toHaveLength(1);
  });

  it('validates create task', () => {
    expect(() =>
      createTaskSchema.parse({
        instruction: 'Open browser',
        deviceId: 'not-a-uuid',
      }),
    ).toThrow();
  });

  it('validates device registration', () => {
    const parsed = registerDeviceWsSchema.parse({
      deviceToken: 'a'.repeat(32),
      deviceName: 'MacBook',
      os: 'darwin',
    });
    expect(parsed.os).toBe('darwin');
  });
});
