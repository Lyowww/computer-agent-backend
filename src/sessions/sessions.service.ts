import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async createDeviceSession(input: {
    deviceId: string;
    userId: string;
    socketId: string;
    ipAddress?: string;
    userAgent?: string;
  }) {
    // Close any prior active sessions for this device
    await this.prisma.deviceSession.updateMany({
      where: { deviceId: input.deviceId, isActive: true },
      data: { isActive: false, disconnectedAt: new Date() },
    });

    return this.prisma.deviceSession.create({
      data: {
        deviceId: input.deviceId,
        userId: input.userId,
        socketId: input.socketId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        isActive: true,
      },
    });
  }

  async endBySocketId(socketId: string) {
    return this.prisma.deviceSession.updateMany({
      where: { socketId, isActive: true },
      data: { isActive: false, disconnectedAt: new Date() },
    });
  }

  async getActiveByDevice(deviceId: string) {
    return this.prisma.deviceSession.findFirst({
      where: { deviceId, isActive: true },
      orderBy: { connectedAt: 'desc' },
    });
  }
}
