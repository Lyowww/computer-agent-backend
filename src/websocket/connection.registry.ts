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
 * Keeps live Socket references so emits do not depend on room join timing.
 */
@Injectable()
export class ConnectionRegistry {
  private readonly logger = new Logger(ConnectionRegistry.name);
  private server: Server | null = null;
  private readonly bySocket = new Map<string, ConnectedClient>();
  private readonly socketRefs = new Map<string, Socket>();
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
    this.socketRefs.set(socket.id, socket);

    // Only web clients join the user room — desktop agents must not receive
    // dashboard fanout (DEVICE_STATUS, SCREEN_RESULT, etc.).
    if (meta.userId && meta.channel === 'web-client') {
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

    this.logger.log(
      `Registered ${meta.channel} socket=${socket.id} user=${meta.userId ?? '-'} device=${meta.deviceId ?? '-'}`,
    );
  }

  unregister(socketId: string): ConnectedClient | undefined {
    const client = this.bySocket.get(socketId);
    if (!client) return undefined;
    this.bySocket.delete(socketId);
    this.socketRefs.delete(socketId);

    if (client.userId && client.channel === 'web-client') {
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
    const socketIds = this.deviceSockets.get(deviceId);
    if (!socketIds || socketIds.size === 0) return false;
    for (const socketId of socketIds) {
      const socket = this.socketRefs.get(socketId);
      if (socket?.connected) return true;
    }
    return false;
  }

  private emitToSocketIds(socketIds: Iterable<string>, event: string, payload: unknown): number {
    let sent = 0;
    for (const socketId of socketIds) {
      const socket = this.socketRefs.get(socketId);
      if (socket?.connected) {
        socket.emit(event, payload);
        socket.emit('message', { event, payload });
        sent += 1;
      } else {
        this.logger.warn(
          `emit skipped — socket not connected id=${socketId} event=${event}`,
        );
      }
    }
    return sent;
  }

  sendToDevice(deviceId: string, event: string, payload: unknown): boolean {
    const socketIds = this.deviceSockets.get(deviceId);
    if (!socketIds || socketIds.size === 0) {
      this.logger.warn(`sendToDevice missed — no sockets for device=${deviceId} event=${event}`);
      return false;
    }

    const sent = this.emitToSocketIds(socketIds, event, payload);
    // Room broadcast as a belt-and-suspenders path for sockets that joined the room
    // but keep success tied to live socket refs (room-only emit can silently no-op).
    if (this.server && sent > 0) {
      this.server.to(`device:${deviceId}`).emit(event, payload);
      this.server.to(`device:${deviceId}`).emit('message', { event, payload });
    }
    this.logger.log(
      `sendToDevice device=${deviceId} event=${event} sockets=${socketIds.size} delivered=${sent}`,
    );
    if (sent === 0) {
      this.logger.warn(
        `sendToDevice failed — device=${deviceId} event=${event} had ${socketIds.size} registered socket(s) but none connected`,
      );
      return false;
    }
    return true;
  }

  sendToUser(userId: string, event: string, payload: unknown): boolean {
    const socketIds = this.userSockets.get(userId) ?? new Set<string>();
    const sent = this.emitToSocketIds(socketIds, event, payload);
    if (this.server && sent > 0) {
      this.server.to(`user:${userId}`).emit(event, payload);
      this.server.to(`user:${userId}`).emit('message', { event, payload });
    }
    this.logger.log(
      `sendToUser user=${userId} event=${event} sockets=${socketIds.size} delivered=${sent}`,
    );
    return sent > 0;
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
