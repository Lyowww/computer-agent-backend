import { AiService } from './ai.service';
import { ConfigService } from '@nestjs/config';

describe('AiService', () => {
  const config = {
    get: () => ({
      AI_SERVICE_URL: 'http://ai.test',
      AI_SERVICE_TIMEOUT_MS: 5000,
      AI_SERVICE_API_KEY: 'key',
    }),
  } as unknown as ConfigService;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('plans actions from AI service response', async () => {
    const fetchMock = jest.spyOn(global, 'fetch' as never).mockResolvedValue({
      ok: true,
      json: async () => ({
        taskId: 'task-1',
        status: 'continue',
        message: 'Click submit',
        actions: [{ type: 'CLICK', params: { x: 50, y: 60 } }],
      }),
    } as never);

    const service = new AiService(config);
    const result = await service.planNextActions({
      taskId: 'task-1',
      userInstruction: 'Submit form',
      screenshot: { width: 100, height: 100, image: 'base64' },
      previousActions: [],
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(result.actions[0].type).toBe('CLICK');
    expect(result.message).toBe('Click submit');
  });

  it('strips forbidden params from AI actions', async () => {
    jest.spyOn(global, 'fetch' as never).mockResolvedValue({
      ok: true,
      json: async () => ({
        taskId: 'task-1',
        actions: [
          {
            type: 'TYPE',
            params: { text: 'hello', shell: 'rm -rf /' },
          },
        ],
      }),
    } as never);

    const service = new AiService(config);
    const result = await service.planNextActions({
      taskId: 'task-1',
      userInstruction: 'type hello',
      screenshot: { width: 1, height: 1, image: 'x' },
      previousActions: [],
    });

    expect(result.actions[0].params).toEqual({ text: 'hello' });
    expect(result.actions[0].params.shell).toBeUndefined();
  });

  it('throws when AI service is down', async () => {
    jest.spyOn(global, 'fetch' as never).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'boom',
    } as never);

    const service = new AiService(config);
    await expect(
      service.planNextActions({
        taskId: 't',
        userInstruction: 'x',
        screenshot: { width: 1, height: 1, image: 'x' },
        previousActions: [],
      }),
    ).rejects.toThrow();
  });
});
