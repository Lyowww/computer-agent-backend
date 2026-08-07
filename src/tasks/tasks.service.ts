import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageRole, TaskStatus } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../database/prisma.service';
import { DevicesService } from '../devices/devices.service';
import { ActionsService } from '../actions/actions.service';
import { AiService } from '../ai/ai.service';
import { ScreenshotsService } from '../screenshots/screenshots.service';
import { ConnectionRegistry } from '../websocket/connection.registry';
import { PendingStore } from '../common/pending/pending.store';
import { assertOwnership } from '../common/guards/auth.guards';
import type { CreateTaskDto } from '../common/validation/schemas';
import type { AppConfig } from '../config/configuration';
import type { ScreenResultPayload } from '../common/events/ws-events';

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: DevicesService,
    private readonly actions: ActionsService,
    private readonly ai: AiService,
    private readonly screenshots: ScreenshotsService,
    private readonly connections: ConnectionRegistry,
    private readonly pending: PendingStore,
    private readonly config: ConfigService,
  ) {}

  async create(userId: string, dto: CreateTaskDto) {
    const app = this.config.get<AppConfig>('app')!;
    const device = await this.devices.assertOwnedAndOnline(userId, dto.deviceId);

    if (!this.connections.isDeviceOnline(device.id)) {
      throw new BadRequestException('Device is not connected via WebSocket');
    }

    const task = await this.prisma.task.create({
      data: {
        userId,
        deviceId: device.id,
        instruction: dto.instruction,
        status: TaskStatus.CREATED,
        maxIterations: dto.maxIterations ?? app.MAX_TASK_ITERATIONS,
      },
    });

    await this.prisma.chatMessage.create({
      data: {
        userId,
        taskId: task.id,
        role: MessageRole.USER,
        content: dto.instruction,
      },
    });

    setImmediate(() => {
      void this.startTask(task.id).catch((err) => {
        this.logger.error(
          `Failed to start task ${task.id}: ${err instanceof Error ? err.message : err}`,
        );
      });
    });

    return task;
  }

  async startTask(taskId: string): Promise<void> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task || task.status === TaskStatus.CANCELLED) return;

    await this.updateStatus(taskId, TaskStatus.RUNNING);
    this.connections.sendToUser(task.userId, 'TASK_START', {
      taskId: task.id,
      instruction: task.instruction,
      deviceId: task.deviceId,
    });

    await this.requestScreenAndPlan(taskId);
  }

  async requestScreenAndPlan(taskId: string): Promise<void> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) return;
    if (this.isTerminal(task.status)) return;

    if (task.iteration >= task.maxIterations) {
      await this.failTask(taskId, 'Maximum task iterations exceeded');
      return;
    }

    const requestId = `req_${uuidv4()}`;
    this.pending.set(`screen-pending:${requestId}`, taskId, 120);
    await this.updateStatus(taskId, TaskStatus.WAITING_FOR_SCREEN);

    const sent = this.connections.requestScreenshot(
      task.deviceId,
      requestId,
      taskId,
    );
    if (!sent) {
      this.pending.del(`screen-pending:${requestId}`);
      await this.failTask(taskId, 'Device is not connected');
    }
  }

  async handleScreenResult(payload: ScreenResultPayload): Promise<void> {
    if (!payload.error && payload.image) {
      // Best-effort ephemeral cache — never block delivery on Redis.
      void this.screenshots.storeEphemeral(payload).catch((err) => {
        this.logger.warn(
          `Screenshot cache failed: ${err instanceof Error ? err.message : err}`,
        );
      });
    }

    let taskId = payload.taskId ?? null;
    if (!taskId) {
      taskId = this.pending.get(`screen-pending:${payload.requestId}`);
    }
    if (taskId) {
      this.pending.del(`screen-pending:${payload.requestId}`);
    }

    // Standalone user capture (dashboard / chat screenshot) — deliver even if taskId is set.
    const captureUserId = this.pending.get(
      `capture-user:${payload.requestId}`,
    );
    if (captureUserId) {
      this.pending.del(`capture-user:${payload.requestId}`);
      this.connections.sendToUser(captureUserId, 'SCREEN_RESULT', {
        requestId: payload.requestId,
        taskId: payload.taskId,
        width: payload.width,
        height: payload.height,
        image: payload.image,
        mimeType: payload.mimeType ?? 'image/png',
        error: payload.error,
      });
      const app = this.config.get<AppConfig>('app')!;
      if (!app.STORE_SCREENSHOTS && payload.image) {
        void this.screenshots.discard(payload.requestId);
      }
      if (!taskId || payload.error) {
        return;
      }
    }

    if (!taskId) {
      this.logger.debug(`Orphan screen result: ${payload.requestId}`);
      return;
    }

    if (payload.error || !payload.image) {
      this.logger.warn(
        `Screen capture failed for task ${taskId}: ${payload.error ?? 'missing image'}`,
      );
      await this.failTask(taskId, payload.error ?? 'Screenshot failed');
      return;
    }

    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) return;

    this.connections.sendToUser(task.userId, 'SCREEN_RESULT', {
      requestId: payload.requestId,
      taskId,
      width: payload.width,
      height: payload.height,
      image: payload.image,
      mimeType: payload.mimeType ?? 'image/png',
    });

    if (!this.isTerminal(task.status)) {
      await this.runAiIteration(taskId, payload);
    }
  }

  async captureScreenForUser(
    userId: string,
    opts: { deviceId?: string; quality?: number; requestId?: string },
  ) {
    const device = await this.devices.getActiveDeviceForUser(
      userId,
      opts.deviceId,
    );
    if (!this.connections.isDeviceOnline(device.id)) {
      throw new BadRequestException('Device is not connected via WebSocket');
    }

    const requestId = opts.requestId ?? `req_${uuidv4()}`;
    this.pending.set(`capture-user:${requestId}`, userId, 120);

    const sent = this.connections.sendToDevice(device.id, 'CAPTURE_SCREEN', {
      requestId,
      quality: opts.quality ?? 80,
      maxWidth: 1280,
      deviceId: device.id,
    });
    if (!sent) {
      this.pending.del(`capture-user:${requestId}`);
      throw new BadRequestException('Failed to reach device');
    }

    return { requestId, deviceId: device.id };
  }

  async notifyDevice(
    userId: string,
    input: {
      requestId: string;
      body: string;
      title?: string;
      deviceId?: string;
      from?: string;
      persist?: boolean;
    },
  ) {
    const device = await this.devices.getActiveDeviceForUser(
      userId,
      input.deviceId,
    );
    if (!this.connections.isDeviceOnline(device.id)) {
      throw new BadRequestException('Device is not connected via WebSocket');
    }

    // Forward to the agent first so UI ACK is not blocked by DB writes.
    this.pending.set(`notify-user:${input.requestId}`, userId, 120);
    const sent = this.connections.sendToDevice(device.id, 'NOTIFY', {
      requestId: input.requestId,
      title: input.title ?? 'Message from dashboard',
      body: input.body,
      from: input.from ?? 'dashboard',
    });
    if (!sent) {
      this.pending.del(`notify-user:${input.requestId}`);
      throw new BadRequestException('Failed to reach device');
    }
    this.logger.log(
      `NOTIFY forwarded to device=${device.id} requestId=${input.requestId}`,
    );

    if (input.persist !== false) {
      void this.prisma.chatMessage
        .create({
          data: {
            userId,
            role: MessageRole.USER,
            content: input.body,
            metadata: { kind: 'notify', deviceId: device.id },
          },
        })
        .catch((err) => {
          this.logger.warn(
            `Failed to persist notify message: ${err instanceof Error ? err.message : err}`,
          );
        });
    }
    return { requestId: input.requestId, deviceId: device.id };
  }

  async requestDeviceList(
    userId: string,
    kind: 'LIST_PROCESSES' | 'LIST_APPS',
    input: { requestId: string; deviceId?: string; limit?: number },
  ) {
    const device = await this.devices.getActiveDeviceForUser(
      userId,
      input.deviceId,
    );
    if (!this.connections.isDeviceOnline(device.id)) {
      throw new BadRequestException('Device is not connected via WebSocket');
    }

    this.pending.set(
      `${kind.toLowerCase()}-user:${input.requestId}`,
      userId,
      120,
    );
    const sent = this.connections.sendToDevice(device.id, kind, {
      requestId: input.requestId,
      limit: input.limit ?? 40,
    });
    if (!sent) {
      throw new BadRequestException('Failed to reach device');
    }
    return { requestId: input.requestId, deviceId: device.id };
  }

  private async runAiIteration(
    taskId: string,
    screen: ScreenResultPayload,
  ): Promise<void> {
    if (!screen.image || screen.width == null || screen.height == null) {
      await this.failTask(taskId, screen.error ?? 'Screenshot missing for AI iteration');
      return;
    }

    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task || task.status === TaskStatus.CANCELLED) return;

    const nextIteration = task.iteration + 1;
    await this.prisma.task.update({
      where: { id: taskId },
      data: { iteration: nextIteration, status: TaskStatus.RUNNING },
    });

    const previousActions = await this.actions.toPreviousActions(taskId);
    const app = this.config.get<AppConfig>('app')!;

    let aiResponse;
    try {
      aiResponse = await this.ai.planNextActions({
        taskId,
        userInstruction: task.instruction,
        screenshot: {
          width: screen.width,
          height: screen.height,
          image: screen.image,
          mimeType: screen.mimeType,
        },
        previousActions,
      });
    } catch (err) {
      await this.failTask(
        taskId,
        err instanceof Error ? err.message : 'AI service error',
      );
      return;
    } finally {
      if (!app.STORE_SCREENSHOTS) {
        await this.screenshots.discard(screen.requestId);
      }
    }

    if (aiResponse.message) {
      await this.prisma.chatMessage.create({
        data: {
          userId: task.userId,
          taskId,
          role: MessageRole.ASSISTANT,
          content: aiResponse.message,
        },
      });
      this.connections.sendToUser(task.userId, 'AI_RESPONSE', {
        taskId,
        content: aiResponse.message,
        actions: aiResponse.actions,
      });
    }

    if (
      aiResponse.status === 'completed' ||
      this.hasTerminal(aiResponse.actions, 'DONE')
    ) {
      await this.completeTask(taskId, aiResponse.message ?? 'Task completed');
      return;
    }

    if (
      aiResponse.status === 'failed' ||
      this.hasTerminal(aiResponse.actions, 'FAIL')
    ) {
      await this.failTask(taskId, aiResponse.message ?? 'AI reported failure');
      return;
    }

    if (aiResponse.status === 'need_user') {
      await this.updateStatus(taskId, TaskStatus.WAITING_FOR_USER);
      return;
    }

    const executable = aiResponse.actions.filter(
      (a) => a.type !== 'DONE' && a.type !== 'FAIL' && a.type !== 'WAIT',
    );

    if (executable.length === 0) {
      const waitAction = aiResponse.actions.find((a) => a.type === 'WAIT');
      if (waitAction) {
        await this.actions.createActions(taskId, nextIteration, [waitAction]);
        const ms = Number(
          waitAction.params.ms ?? waitAction.params.durationMs ?? 500,
        );
        await new Promise((r) =>
          setTimeout(r, Math.min(Math.max(ms, 0), 10_000)),
        );
      }
      await this.requestScreenAndPlan(taskId);
      return;
    }

    const created = await this.actions.createActions(
      taskId,
      nextIteration,
      executable,
    );
    await this.updateStatus(taskId, TaskStatus.WAITING_FOR_ACTION);

    for (const action of created) {
      await this.actions.markSent(action.actionId);
      const sent = this.connections.sendToDevice(
        task.deviceId,
        'EXECUTE_ACTION',
        {
          actionId: action.actionId,
          taskId,
          type: action.type,
          params: action.params,
        },
      );
      if (!sent) {
        await this.failTask(taskId, 'Device disconnected while sending action');
        return;
      }
    }
  }

  async handleActionResult(input: {
    actionId: string;
    taskId: string;
    success: boolean;
    result?: Record<string, unknown>;
    error?: string;
  }): Promise<void> {
    const action = await this.actions.recordResult(input);
    const task = await this.prisma.task.findUnique({
      where: { id: input.taskId },
    });
    if (!task || this.isTerminal(task.status)) return;

    this.connections.sendToUser(task.userId, 'ACTION_RESULT', {
      actionId: input.actionId,
      taskId: input.taskId,
      success: input.success,
      result: input.result,
      error: input.error,
    });

    const pending = await this.prisma.taskAction.count({
      where: {
        taskId: input.taskId,
        iteration: action.iteration,
        status: { in: ['PENDING', 'SENT'] },
      },
    });

    if (pending === 0) {
      if (!input.success) {
        this.logger.warn(`Action ${input.actionId} failed: ${input.error}`);
      }
      await this.requestScreenAndPlan(input.taskId);
    }
  }

  async cancel(userId: string, taskId: string) {
    const task = await this.getOwned(userId, taskId);
    if (this.isTerminal(task.status)) {
      throw new BadRequestException(`Task already ${task.status}`);
    }
    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: { status: TaskStatus.CANCELLED, completedAt: new Date() },
    });
    this.connections.sendToUser(userId, 'TASK_UPDATE', {
      taskId,
      status: TaskStatus.CANCELLED,
    });
    return updated;
  }

  async list(userId: string) {
    return this.prisma.task.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        device: {
          select: {
            id: true,
            name: true,
            os: true,
            connectionStatus: true,
          },
        },
      },
    });
  }

  async getById(userId: string, taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        device: {
          select: {
            id: true,
            name: true,
            os: true,
            connectionStatus: true,
          },
        },
        actions: { orderBy: { createdAt: 'asc' } },
        chatMessages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!task) throw new NotFoundException('Task not found');
    assertOwnership(task.userId, userId, 'task');
    return task;
  }

  async handleUserMessage(
    userId: string,
    input: {
      content: string;
      taskId?: string;
      deviceId?: string;
      useAi?: boolean;
      requestId?: string;
    },
  ) {
    const useAi = input.useAi !== false;

    // Persist chat off the ACK path so Redis/DB latency cannot time out the web client.
    void this.prisma.chatMessage
      .create({
        data: {
          userId,
          taskId: input.taskId,
          role: MessageRole.USER,
          content: input.content,
          metadata: { useAi },
        },
      })
      .catch((err) => {
        this.logger.warn(
          `Failed to persist chat message: ${err instanceof Error ? err.message : err}`,
        );
      });

    // Notify-only path: no AI planning / no task loop
    if (!useAi) {
      const requestId = input.requestId ?? `notify_${uuidv4()}`;
      const result = await this.notifyDevice(userId, {
        requestId,
        body: input.content,
        title: 'Message from dashboard',
        deviceId: input.deviceId,
        persist: false,
      });
      return { ok: true, mode: 'notify' as const, ...result };
    }

    if (input.taskId) {
      const task = await this.getOwned(userId, input.taskId);
      if (task.status === TaskStatus.WAITING_FOR_USER) {
        await this.prisma.task.update({
          where: { id: task.id },
          data: { instruction: `${task.instruction}\n\nUser: ${input.content}` },
        });
        await this.requestScreenAndPlan(task.id);
        return { ok: true, mode: 'ai' as const, resumedTaskId: task.id };
      }
    }

    // New ad-hoc AI task from chat
    if (input.deviceId || !input.taskId) {
      const device = await this.devices.getActiveDeviceForUser(
        userId,
        input.deviceId,
      );
      const task = await this.create(userId, {
        instruction: input.content,
        deviceId: device.id,
      });
      return { ok: true, mode: 'ai' as const, taskId: task.id };
    }

    return { ok: true, mode: 'ai' as const };
  }

  private async getOwned(userId: string, taskId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Task not found');
    assertOwnership(task.userId, userId, 'task');
    return task;
  }

  private async updateStatus(taskId: string, status: TaskStatus) {
    const task = await this.prisma.task.update({
      where: { id: taskId },
      data: { status },
    });
    this.connections.sendToUser(task.userId, 'TASK_UPDATE', {
      taskId,
      status,
      iteration: task.iteration,
    });
    return task;
  }

  private async completeTask(taskId: string, summary: string) {
    const task = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.COMPLETED,
        resultSummary: summary,
        completedAt: new Date(),
      },
    });
    this.connections.sendToUser(task.userId, 'TASK_COMPLETED', {
      taskId,
      status: TaskStatus.COMPLETED,
      message: summary,
    });
  }

  private async failTask(taskId: string, errorMessage: string) {
    const task = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.FAILED,
        errorMessage,
        completedAt: new Date(),
      },
    });
    this.connections.sendToUser(task.userId, 'TASK_FAILED', {
      taskId,
      status: TaskStatus.FAILED,
      message: errorMessage,
    });
  }

  private isTerminal(status: TaskStatus): boolean {
    return (
      status === TaskStatus.COMPLETED ||
      status === TaskStatus.FAILED ||
      status === TaskStatus.CANCELLED
    );
  }

  private hasTerminal(
    actions: { type: string }[],
    type: 'DONE' | 'FAIL',
  ): boolean {
    return actions.some((a) => a.type === type);
  }
}
