import { Controller, Get, Query } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CurrentUser, type AuthUser } from '../common/guards/auth.guards';

@Controller('chat')
export class ChatController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('history')
  async history(
    @CurrentUser() user: AuthUser,
    @Query('taskId') taskId?: string,
    @Query('limit') limitStr?: string,
  ) {
    const limit = Math.min(Math.max(Number(limitStr) || 50, 1), 200);
    return this.prisma.chatMessage.findMany({
      where: {
        userId: user.userId,
        ...(taskId ? { taskId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
