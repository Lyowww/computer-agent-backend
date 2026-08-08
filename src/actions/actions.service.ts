import { Injectable, NotFoundException } from '@nestjs/common';
import { ActionStatus, ActionType, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { ValidatedAction } from '../common/validation/schemas';

@Injectable()
export class ActionsService {
  constructor(private readonly prisma: PrismaService) {}

  async createActions(
    taskId: string,
    iteration: number,
    actions: ValidatedAction[],
  ) {
    const created = [];
    for (const action of actions) {
      const row = await this.prisma.taskAction.create({
        data: {
          taskId,
          iteration,
          type: action.type as ActionType,
          params: action.params as Prisma.InputJsonValue,
          status: ActionStatus.PENDING,
        },
      });
      created.push(row);
    }
    return created;
  }

  async markSent(actionId: string) {
    return this.prisma.taskAction.update({
      where: { actionId },
      data: { status: ActionStatus.SENT },
    });
  }

  async recordResult(input: {
    actionId: string;
    success: boolean;
    result?: Record<string, unknown>;
    error?: string;
  }) {
    const existing = await this.prisma.taskAction.findUnique({
      where: { actionId: input.actionId },
    });
    if (!existing) {
      throw new NotFoundException('Action not found');
    }

    if (
      existing.status === ActionStatus.SUCCEEDED ||
      existing.status === ActionStatus.FAILED
    ) {
      return { action: existing, duplicate: true as const };
    }

    const action = await this.prisma.taskAction.update({
      where: { actionId: input.actionId },
      data: {
        status: input.success ? ActionStatus.SUCCEEDED : ActionStatus.FAILED,
        result: (input.result ?? null) as Prisma.InputJsonValue,
        errorMessage: input.error,
        completedAt: new Date(),
      },
    });
    return { action, duplicate: false as const };
  }

  async listForTask(taskId: string) {
    return this.prisma.taskAction.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async toPreviousActions(taskId: string) {
    const actions = await this.listForTask(taskId);
    return actions.map((a) => ({
      type: a.type,
      params: (a.params ?? {}) as Record<string, unknown>,
      success: a.status === ActionStatus.SUCCEEDED,
      result: (a.result ?? undefined) as Record<string, unknown> | undefined,
    }));
  }
}
