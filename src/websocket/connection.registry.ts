import { Injectable, Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import type { WsChannel } from '../common/events/ws-events';

export interface ConnectedClient {
  socketId: string;
  channel: WsChannel;
  userId?: string;
  deviceId?: string;
  connectedAt: number;
  lastPongAt: number;
}

/**
 * In-memory registry of WebSocket connections.
 * Separates routing from Nest gateways so tasks/AI can emit without circular deps.
 */
@Injectable()
export class ConnectionRegistry {
  private readonly logger = new Logger(ConnectionRegistry.name);
  private server: Server | null = null;
  private readonly bySocket = new Map<string, ConnectedClient>();
  private readonly userSockets = new Map<string, Set<string>>();
  private readonly deviceSockets = new Map<string, Set<string>>();

  setServer(server: Server): void {
    this.server = server;
  }

  async register(
    socket: Socket,
    meta: Omit<ConnectedClient, 'socketId' | 'connectedAt' | 'lastPongAt'>,
  ): Promise<void> {
    const client: ConnectedClient = {
      socketId: socket.id,
      channel: meta.channel,
      userId: meta.userId,
      deviceId: meta.deviceId,
      connectedAt: Date.now(),
      lastPongAt: Date.now(),
    };
    this.bySocket.set(socket.id, client);

    if (meta.userId) {
      const set = this.userSockets.get(meta.userId) ?? new Set();
      set.add(socket.id);
      this.userSockets.set(meta.userId, set);
      await socket.join(`user:${meta.userId}`);
    }
    if (meta.deviceId) {
      const set = this.deviceSockets.get(meta.deviceId) ?? new Set();
      set.add(socket.id);
      this.deviceSockets.set(meta.deviceId, set);
      await socket.join(`device:${meta.deviceId}`);
    }

    this.logger.debug(
      `Registered ${meta.channel} socket=${socket.id} user=${meta.userId ?? '-'} device=${meta.deviceId ?? '-'}`,
    );
  }

  unregister(socketId: string): ConnectedClient | undefined {
    const client = this.bySocket.get(socketId);
    if (!client) return undefined;
    this.bySocket.delete(socketId);

    if (client.userId) {
      const set = this.userSockets.get(client.userId);
      set?.delete(socketId);
      if (set && set.size === 0) this.userSockets.delete(client.userId);
    }
    if (client.deviceId) {
      const set = this.deviceSockets.get(client.deviceId);
      set?.delete(socketId);
      if (set && set.size === 0) this.deviceSockets.delete(client.deviceId);
    }
    return client;
  }

  get(socketId: string): ConnectedClient | undefined {
    return this.bySocket.get(socketId);
  }

  touchPong(socketId: string): void {
    const client = this.bySocket.get(socketId);
    if (client) client.lastPongAt = Date.now();
  }

  isDeviceOnline(deviceId: string): boolean {
    return (this.deviceSockets.get(deviceId)?.size ?? 0) > 0;
  }

  sendToDevice(deviceId: string, event: string, payload: unknown): boolean {
    if (!this.server) return false;
    const socketIds = this.deviceSockets.get(deviceId);
    if (!socketIds || socketIds.size === 0) return false;

    // Each socket automatically joins a room named after its id — reliable even
    // when namespace typing makes `.sockets` maps awkward.
    for (const socketId of socketIds) {
      this.server.to(socketId).emit(event, payload);
      this.server.to(socketId).emit('message', { event, payload });
    }
    this.server.to(`device:${deviceId}`).emit(event, payload);
    this.server.to(`device:${deviceId}`).emit('message', { event, payload });
    return true;
  }

  sendToUser(userId: string, event: string, payload: unknown): boolean {
    if (!this.server) return false;
    const socketIds = this.userSockets.get(userId);
    if (socketIds) {
      for (const socketId of socketIds) {
        this.server.to(socketId).emit(event, payload);
        this.server.to(socketId).emit('message', { event, payload });
      }
    }
    this.server.to(`user:${userId}`).emit(event, payload);
    this.server.to(`user:${userId}`).emit('message', { event, payload });
    return true;
  }

  requestScreenshot(deviceId: string, requestId: string, taskId: string, quality = 80): boolean {
    return this.sendToDevice(deviceId, 'CAPTURE_SCREEN', {
      requestId,
      taskId,
      quality,
      maxWidth: 1280,
    });
  }

  getStaleSockets(timeoutMs: number): ConnectedClient[] {
    const now = Date.now();
    return [...this.bySocket.values()].filter(
      (c) => now - c.lastPongAt > timeoutMs,
    );
  }
}
