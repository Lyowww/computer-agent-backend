import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectionStatus, DeviceOs } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  generateSecureToken,
  hashToken,
  tokenPrefix,
  verifyToken,
} from '../common/crypto/crypto.util';
import { assertOwnership } from '../common/guards/auth.guards';
import type { CreateDeviceDto } from '../common/validation/schemas';
import type { AppConfig } from '../config/configuration';

const DEVICE_SAFE_SELECT = {
  id: true,
  userId: true,
  name: true,
  os: true,
  connectionStatus: true,
  lastSeenAt: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
  deviceToken: true,
} as const;

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Provision a new device. Token is stored and returned so the dashboard can always show it.
   */
  async create(userId: string, dto: CreateDeviceDto) {
    const app = this.config.get<AppConfig>('app')!;
    const deviceToken = generateSecureToken(app.DEVICE_TOKEN_BYTES);
    const tokenHash = await hashToken(deviceToken);
    const prefix = tokenPrefix(deviceToken);

    const device = await this.prisma.device.create({
      data: {
        userId,
        name: dto.name,
        os: dto.os as DeviceOs,
        tokenHash,
        tokenPrefix: prefix,
        deviceToken,
        connectionStatus: ConnectionStatus.OFFLINE,
      },
      select: DEVICE_SAFE_SELECT,
    });

    return {
      device,
      deviceToken,
      warning:
        'Paste this device token into the desktop agent. It stays visible on the Devices page.',
    };
  }

  async list(userId: string) {
    return this.prisma.device.findMany({
      where: { userId, revokedAt: null },
      select: DEVICE_SAFE_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async getById(userId: string, deviceId: string) {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: DEVICE_SAFE_SELECT,
    });
    if (!device) throw new NotFoundException('Device not found');
    assertOwnership(device.userId, userId, 'device');
    return device;
  }

  /**
   * Rotate token and return the new plaintext (also stored for dashboard display).
   */
  async regenerateToken(userId: string, deviceId: string) {
    await this.getById(userId, deviceId);
    const app = this.config.get<AppConfig>('app')!;
    const deviceToken = generateSecureToken(app.DEVICE_TOKEN_BYTES);
    const tokenHash = await hashToken(deviceToken);
    const prefix = tokenPrefix(deviceToken);

    const device = await this.prisma.device.update({
      where: { id: deviceId },
      data: {
        tokenHash,
        tokenPrefix: prefix,
        deviceToken,
        connectionStatus: ConnectionStatus.OFFLINE,
      },
      select: DEVICE_SAFE_SELECT,
    });

    return { device, deviceToken };
  }

  async revoke(userId: string, deviceId: string) {
    const device = await this.getById(userId, deviceId);
    return this.prisma.device.update({
      where: { id: device.id },
      data: {
        revokedAt: new Date(),
        connectionStatus: ConnectionStatus.REVOKED,
        tokenHash: await hashToken(generateSecureToken(32)),
        tokenPrefix: tokenPrefix(generateSecureToken(32)),
        deviceToken: null,
      },
      select: DEVICE_SAFE_SELECT,
    });
  }

  /**
   * Authenticate a desktop agent by device token.
   * Never trust a bare device ID.
   */
  async authenticateByToken(deviceToken: string) {
    const prefix = tokenPrefix(deviceToken);
    const candidates = await this.prisma.device.findMany({
      where: {
        tokenPrefix: prefix,
        revokedAt: null,
      },
    });

    for (const device of candidates) {
      const ok = await verifyToken(deviceToken, device.tokenHash);
      if (ok) {
        if (device.connectionStatus === ConnectionStatus.REVOKED) {
          throw new UnauthorizedException('Device revoked');
        }
        // Backfill plaintext for older devices created before this column existed.
        if (!device.deviceToken) {
          await this.prisma.device.update({
            where: { id: device.id },
            data: { deviceToken },
          });
        }
        return device;
      }
    }

    throw new UnauthorizedException('Invalid device token');
  }

  async markOnline(deviceId: string) {
    return this.prisma.device.update({
      where: { id: deviceId },
      data: {
        connectionStatus: ConnectionStatus.ONLINE,
        lastSeenAt: new Date(),
      },
      select: DEVICE_SAFE_SELECT,
    });
  }

  async markOffline(deviceId: string) {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device || device.revokedAt) return null;
    return this.prisma.device.update({
      where: { id: deviceId },
      data: {
        connectionStatus: ConnectionStatus.OFFLINE,
        lastSeenAt: new Date(),
      },
      select: DEVICE_SAFE_SELECT,
    });
  }

  async touch(deviceId: string) {
    return this.prisma.device.update({
      where: { id: deviceId },
      data: { lastSeenAt: new Date() },
      select: DEVICE_SAFE_SELECT,
    });
  }

  async getActiveDeviceForUser(userId: string, preferredDeviceId?: string) {
    if (preferredDeviceId) {
      const device = await this.prisma.device.findFirst({
        where: {
          id: preferredDeviceId,
          userId,
          revokedAt: null,
          connectionStatus: ConnectionStatus.ONLINE,
        },
        select: DEVICE_SAFE_SELECT,
      });
      if (!device) {
        throw new ForbiddenException('Preferred device is not online');
      }
      return device;
    }

    const device = await this.prisma.device.findFirst({
      where: {
        userId,
        revokedAt: null,
        connectionStatus: ConnectionStatus.ONLINE,
      },
      orderBy: { lastSeenAt: 'desc' },
      select: DEVICE_SAFE_SELECT,
    });
    if (!device) {
      throw new NotFoundException('No online device found for user');
    }
    return device;
  }

  async assertOwnedAndOnline(userId: string, deviceId: string) {
    const device = await this.getById(userId, deviceId);
    if (device.connectionStatus !== ConnectionStatus.ONLINE) {
      throw new ForbiddenException('Device is not online');
    }
    return device;
  }
}
