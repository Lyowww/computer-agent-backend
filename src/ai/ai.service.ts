import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration';
import {
  aiServiceResponseSchema,
  type AiServiceResponse,
} from '../common/validation/schemas';

export interface AiScreenshot {
  width: number;
  height: number;
  image: string;
  mimeType?: string;
}

export interface AiPreviousAction {
  type: string;
  params: Record<string, unknown>;
  success?: boolean;
  result?: Record<string, unknown>;
}

export interface AiRequest {
  taskId: string;
  userInstruction: string;
  screenshot: AiScreenshot;
  previousActions: AiPreviousAction[];
}

export interface AiServicePort {
  planNextActions(request: AiRequest): Promise<AiServiceResponse>;
}

/**
 * HTTP adapter to an external AI service.
 * The backend never executes computer actions itself.
 */
@Injectable()
export class AiService implements AiServicePort {
  private readonly logger = new Logger(AiService.name);

  constructor(private readonly config: ConfigService) {}

  async planNextActions(request: AiRequest): Promise<AiServiceResponse> {
    const app = this.config.get<AppConfig>('app')!;
    const url = `${app.AI_SERVICE_URL.replace(/\/$/, '')}/v1/plan`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), app.AI_SERVICE_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (app.AI_SERVICE_API_KEY) {
        headers.Authorization = `Bearer ${app.AI_SERVICE_API_KEY}`;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          taskId: request.taskId,
          userInstruction: request.userInstruction,
          screenshot: request.screenshot,
          previousActions: request.previousActions,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        this.logger.error(`AI service error ${response.status}: ${text}`);
        throw new ServiceUnavailableException('AI service unavailable');
      }

      const json = (await response.json()) as Record<string, unknown>;
      const sanitized = this.sanitizeRawResponse(json, request.taskId);
      const parsed = aiServiceResponseSchema.safeParse(sanitized);

      if (!parsed.success) {
        this.logger.error(`Invalid AI response: ${parsed.error.message}`);
        throw new ServiceUnavailableException('AI service returned invalid actions');
      }

      return parsed.data;
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.error(
        `AI service call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException('AI service unavailable');
    } finally {
      clearTimeout(timer);
    }
  }

  private readonly forbiddenKeys = [
    'command',
    'shell',
    'exec',
    'script',
    'powershell',
    'bash',
    'cmd',
  ];

  /** Strip forbidden params before schema validation */
  private sanitizeRawResponse(
    json: Record<string, unknown>,
    fallbackTaskId: string,
  ): Record<string, unknown> {
    const actions = Array.isArray(json.actions) ? json.actions : [];
    return {
      ...json,
      taskId: json.taskId ?? fallbackTaskId,
      actions: actions.map((raw) => {
        const action = (raw ?? {}) as Record<string, unknown>;
        const params = (action.params ?? {}) as Record<string, unknown>;
        return {
          ...action,
          params: Object.fromEntries(
            Object.entries(params).filter(
              ([key]) => !this.forbiddenKeys.includes(key.toLowerCase()),
            ),
          ),
        };
      }),
    };
  }
}
