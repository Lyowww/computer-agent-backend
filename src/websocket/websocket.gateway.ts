import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import {
  Logger,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { AgentEventType } from '@prisma/client';
import { ConnectionRegistry } from './connection.registry';
import { DevicesService } from '../devices/devices.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { PrismaService } from '../database/prisma.service';
import { PendingStore } from '../common/pending/pending.store';
import { Public } from '../common/guards/auth.guards';
import { WsEvent } from '../common/events/ws-events';
import {
  actionResultSchema,
  appsResultSchema,
  captureScreenSchema,
  listQuerySchema,
  notifyResultSchema,
  notifySchema,
  pingSchema,
  processesResultSchema,
  registerDeviceWsSchema,
  screenResultSchema,
  userMessageSchema,
} from '../common/validation/schemas';
import type { AppConfig } from '../config/configuration';

function extractBearer(socket: Socket): string | null {
  const auth = socket.handshake.auth as Record<string, unknown> | undefined;
  if (auth?.token && typeof auth.token === 'string') return auth.token;
  const header = socket.handshake.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7);
  }
  const q = socket.handshake.query.token;
  if (typeof q === 'string') return q;
  return null;
}

@Public()
@WebSocketGateway({
  cors: { origin: true, credentials: true },
  namespace: '/ws',
  transports: ['websocket', 'polling'],
  // Screenshots are base64 PNG; default ~1MB buffer drops SCREEN_RESULT silently.
  maxHttpBufferSize: 15e6,
})
export class AppWebsocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(AppWebsocketGateway.name);
  private heartbeatTimer?: NodeJS.Timeout;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly connections: ConnectionRegistry,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly devices: DevicesService,
    private readonly sessions: SessionsService,
    private readonly tasks: TasksService,
    private readonly prisma: PrismaService,
    private readonly pending: PendingStore,
  ) {}

  afterInit(server: Server): void {
    this.connections.setServer(server);
    const app = this.config.get<AppConfig>('app')!;
    const interval = Math.max(10_000, Math.floor(app.CONNECTION_TIMEOUT_MS / 3));
    this.heartbeatTimer = setInterval(() => {
      void this.enforceTimeouts();
    }, interval);
    this.logger.log('WebSocket gateway initialized (namespaces: web-client, desktop-agent via channel query)');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  async handleConnection(socket: Socket): Promise<void> {
    try {
      const channel = String(socket.handshake.query.channel ?? '');
      if (channel !== 'web-client' && channel !== 'desktop-agent') {
        this.emitError(socket, 'INVALID_CHANNEL', 'channel must be web-client or desktop-agent');
        socket.disconnect(true);
        return;
      }

      // Desktop agents must NOT authenticate with a user JWT alone —
      // they register via REGISTER_DEVICE with a device token.
      if (channel === 'web-client') {
        const token = extractBearer(socket);
        if (!token) {
          throw new UnauthorizedException('Missing JWT');
        }
        const payload = await this.jwt.verifyAsync<{ sub: string; email: string }>(
          token,
          { secret: this.config.get<AppConfig>('app')!.JWT_SECRET },
        );
        await this.connections.register(socket, {
          channel: 'web-client',
          userId: payload.sub,
        });
        socket.data.userId = payload.sub;
        socket.data.channel = 'web-client';
        this.logger.log(`web-client connected user=${payload.sub}`);
        return;
      }

      // desktop-agent: allow connect, require REGISTER_DEVICE soon
      socket.data.channel = 'desktop-agent';
      socket.data.authenticated = false;
      this.logger.log(`desktop-agent socket opened ${socket.id} (awaiting REGISTER_DEVICE)`);

      // Auto-disconnect if not registered within timeout
      const app = this.config.get<AppConfig>('app')!;
      setTimeout(() => {
        if (!socket.data.authenticated) {
          this.emitError(socket, 'AUTH_TIMEOUT', 'Device registration timed out');
          socket.disconnect(true);
        }
      }, app.CONNECTION_TIMEOUT_MS);
    } catch (err) {
      this.emitError(
        socket,
        'UNAUTHORIZED',
        err instanceof Error ? err.message : 'Unauthorized',
      );
      socket.disconnect(true);
    }
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    const client = this.connections.unregister(socket.id);
    if (client?.deviceId) {
      await this.sessions.endBySocketId(socket.id);
      const device = await this.devices.markOffline(client.deviceId);
      if (device && client.userId) {
        this.connections.sendToUser(client.userId, WsEvent.DEVICE_STATUS, {
          deviceId: device.id,
          connectionStatus: device.connectionStatus,
          lastSeenAt: device.lastSeenAt,
        });
      }
      await this.prisma.agentEvent.create({
        data: {
          deviceId: client.deviceId,
          type: AgentEventType.DISCONNECT,
          event: 'DISCONNECT',
          payload: { socketId: socket.id },
        },
      });
    }
  }

  // -------- desktop-agent events --------

  @SubscribeMessage(WsEvent.REGISTER_DEVICE)
  async onRegisterDevice(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    if (socket.data.channel !== 'desktop-agent') {
      return this.fail(socket, 'FORBIDDEN', 'REGISTER_DEVICE only for desktop-agent');
    }
    if (!(await this.rateLimit(socket))) {
      return this.fail(socket, 'RATE_LIMITED', 'Too many messages');
    }

    const parsed = registerDeviceWsSchema.safeParse(body);
    if (!parsed.success) {
      return this.fail(
        socket,
        'VALIDATION_ERROR',
        'Invalid REGISTER_DEVICE payload',
        parsed.error.issues,
      );
    }

    try {
      const device = await this.devices.authenticateByToken(parsed.data.deviceToken);
      // Optionally update name/os from agent
      await this.prisma.device.update({
        where: { id: device.id },
        data: {
          name: parsed.data.deviceName || device.name,
          os: parsed.data.os,
        },
      });

      const online = await this.devices.markOnline(device.id);
      await this.sessions.createDeviceSession({
        deviceId: device.id,
        userId: device.userId,
        socketId: socket.id,
        ipAddress: socket.handshake.address,
        userAgent: socket.handshake.headers['user-agent'],
      });

      await this.connections.register(socket, {
        channel: 'desktop-agent',
        userId: device.userId,
        deviceId: device.id,
      });
      socket.data.authenticated = true;
      socket.data.deviceId = device.id;
      socket.data.userId = device.userId;

      await this.prisma.agentEvent.create({
        data: {
          deviceId: device.id,
          type: AgentEventType.REGISTER,
          event: WsEvent.REGISTER_DEVICE,
          payload: { deviceName: parsed.data.deviceName, os: parsed.data.os },
        },
      });

      this.connections.sendToUser(device.userId, WsEvent.DEVICE_STATUS, {
        deviceId: online.id,
        connectionStatus: online.connectionStatus,
        lastSeenAt: online.lastSeenAt,
        name: online.name,
        os: online.os,
      });

      const responsePayload = {
        deviceId: device.id,
        name: online.name,
        os: online.os,
        connectionStatus: online.connectionStatus,
      };
      socket.emit(WsEvent.DEVICE_REGISTERED, responsePayload);
      // Return plain object (no `event`) so Nest uses Socket.IO ack instead of emitting null.
      return { ok: true, ...responsePayload };
    } catch (err) {
      return this.fail(
        socket,
        'DEVICE_AUTH_FAILED',
        err instanceof Error ? err.message : 'Device authentication failed',
      );
    }
  }

  @SubscribeMessage(WsEvent.SCREEN_RESULT)
  async onScreenResult(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    if (!this.requireAgent(socket)) {
      return this.fail(socket, 'UNAUTHORIZED', 'Device not registered');
    }
    if (!(await this.rateLimit(socket))) {
      return this.fail(socket, 'RATE_LIMITED', 'Too many messages');
    }

    const parsed = screenResultSchema.safeParse(body);
    if (!parsed.success) {
      return this.fail(socket, 'VALIDATION_ERROR', 'Invalid SCREEN_RESULT', parsed.error.issues);
    }

    await this.devices.touch(socket.data.deviceId);
    await this.tasks.handleScreenResult(parsed.data);
    return { ok: true, requestId: parsed.data.requestId };
  }

  @SubscribeMessage(WsEvent.ACTION_RESULT)
  async onActionResult(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    if (!this.requireAgent(socket)) {
      return this.fail(socket, 'UNAUTHORIZED', 'Device not registered');
    }
    if (!(await this.rateLimit(socket))) {
      return this.fail(socket, 'RATE_LIMITED', 'Too many messages');
    }

    const parsed = actionResultSchema.safeParse(body);
    if (!parsed.success) {
      return this.fail(socket, 'VALIDATION_ERROR', 'Invalid ACTION_RESULT', parsed.error.issues);
    }

    const task = await this.prisma.task.findUnique({
      where: { id: parsed.data.taskId },
    });
    if (!task || task.deviceId !== socket.data.deviceId) {
      return this.fail(socket, 'FORBIDDEN', 'Action does not belong to this device');
    }

    await this.devices.touch(socket.data.deviceId);
    await this.tasks.handleActionResult(parsed.data);
    return { ok: true, actionId: parsed.data.actionId };
  }

  @SubscribeMessage(WsEvent.NOTIFY_RESULT)
  async onNotifyResult(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    if (!this.requireAgent(socket)) {
      return this.fail(socket, 'UNAUTHORIZED', 'Device not registered');
    }
    const parsed = notifyResultSchema.safeParse(body);
    if (!parsed.success) {
      return this.fail(socket, 'VALIDATION_ERROR', 'Invalid NOTIFY_RESULT', parsed.error.issues);
    }
    const userId = this.pending.get(`notify-user:${parsed.data.requestId}`);
    if (userId) {
      this.connections.sendToUser(userId, WsEvent.NOTIFY_RESULT, parsed.data);
      this.pending.del(`notify-user:${parsed.data.requestId}`);
    }
    return { ok: true };
  }

  @SubscribeMessage(WsEvent.PROCESSES_RESULT)
  async onProcessesResult(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    if (!this.requireAgent(socket)) {
      return this.fail(socket, 'UNAUTHORIZED', 'Device not registered');
    }
    const parsed = processesResultSchema.safeParse(body);
    if (!parsed.success) {
      return this.fail(socket, 'VALIDATION_ERROR', 'Invalid PROCESSES_RESULT', parsed.error.issues);
    }
    const userId = this.pending.get(
      `list_processes-user:${parsed.data.requestId}`,
    );
    if (userId) {
      this.connections.sendToUser(userId, WsEvent.PROCESSES_RESULT, parsed.data);
      this.pending.del(`list_processes-user:${parsed.data.requestId}`);
    }
    return { ok: true };
  }

  @SubscribeMessage(WsEvent.APPS_RESULT)
  async onAppsResult(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    if (!this.requireAgent(socket)) {
      return this.fail(socket, 'UNAUTHORIZED', 'Device not registered');
    }
    const parsed = appsResultSchema.safeParse(body);
    if (!parsed.success) {
      return this.fail(socket, 'VALIDATION_ERROR', 'Invalid APPS_RESULT', parsed.error.issues);
    }
    const userId = this.pending.get(`list_apps-user:${parsed.data.requestId}`);
    if (userId) {
      this.connections.sendToUser(userId, WsEvent.APPS_RESULT, parsed.data);
      this.pending.del(`list_apps-user:${parsed.data.requestId}`);
    }
    return { ok: true };
  }

  // -------- web-client events --------

  @SubscribeMessage(WsEvent.CAPTURE_SCREEN)
  async onCaptureScreen(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    if (socket.data.channel !== 'web-client' || !socket.data.userId) {
      return this.fail(socket, 'FORBIDDEN', 'CAPTURE_SCREEN only for web-client');
    }
    if (!(await this.rateLimit(socket))) {
      return this.fail(socket, 'RATE_LIMITED', 'Too many messages');
    }

    const parsed = captureScreenSchema.safeParse(body);
    if (!parsed.success) {
      return this.fail(socket, 'VALIDATION_ERROR', 'Invalid CAPTURE_SCREEN', parsed.error.issues);
    }

    try {
      const result = await this.tasks.captureScreenForUser(socket.data.userId, {
        requestId: parsed.data.requestId,
        quality: parsed.data.quality,
        deviceId: parsed.data.deviceId,
      });
      return { ok: true, ...result };
    } catch (err) {
      return this.fail(
        socket,
        'CAPTURE_FAILED',
        err instanceof Error ? err.message : 'Capture failed',
        undefined,
        parsed.data.requestId,
      );
    }
  }

  @SubscribeMessage(WsEvent.USER_MESSAGE)
  async onUserMessage(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    if (socket.data.channel !== 'web-client' || !socket.data.userId) {
      return this.fail(socket, 'FORBIDDEN', 'USER_MESSAGE only for web-client');
    }
    if (!(await this.rateLimit(socket))) {
      return this.fail(socket, 'RATE_LIMITED', 'Too many messages');
    }

    const parsed = userMessageSchema.safeParse(body);
    if (!parsed.success) {
      return this.fail(socket, 'VALIDATION_ERROR', 'Invalid USER_MESSAGE', parsed.error.issues);
    }

    try {
      const result = await this.tasks.handleUserMessage(socket.data.userId, parsed.data);
      return { requestId: parsed.data.requestId, ...result };
    } catch (err) {
      return this.fail(
        socket,
        'USER_MESSAGE_FAILED',
        err instanceof Error ? err.message : 'Failed to handle message',
        undefined,
        parsed.data.requestId,
      );
    }
  }

  @SubscribeMessage(WsEvent.NOTIFY)
  async onNotify(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    if (socket.data.channel !== 'web-client' || !socket.data.userId) {
      return this.fail(socket, 'FORBIDDEN', 'NOTIFY only for web-client');
    }
    if (!(await this.rateLimit(socket))) {
      return this.fail(socket, 'RATE_LIMITED', 'Too many messages');
    }
    const parsed = notifySchema.safeParse(body);
    if (!parsed.success) {
      return this.fail(socket, 'VALIDATION_ERROR', 'Invalid NOTIFY', parsed.error.issues);
    }
    try {
      const result = await this.tasks.notifyDevice(socket.data.userId, parsed.data);
      return { ok: true, ...result };
    } catch (err) {
      return this.fail(
        socket,
        'NOTIFY_FAILED',
        err instanceof Error ? err.message : 'Notify failed',
        undefined,
        parsed.data.requestId,
      );
    }
  }

  @SubscribeMessage(WsEvent.LIST_PROCESSES)
  async onListProcesses(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    if (socket.data.channel !== 'web-client' || !socket.data.userId) {
      return this.fail(socket, 'FORBIDDEN', 'LIST_PROCESSES only for web-client');
    }
    if (!(await this.rateLimit(socket))) {
      return this.fail(socket, 'RATE_LIMITED', 'Too many messages');
    }
    const parsed = listQuerySchema.safeParse(body);
    if (!parsed.success) {
      return this.fail(socket, 'VALIDATION_ERROR', 'Invalid LIST_PROCESSES', parsed.error.issues);
    }
    try {
      const result = await this.tasks.requestDeviceList(
        socket.data.userId,
        'LIST_PROCESSES',
        parsed.data,
      );
      return { ok: true, ...result };
    } catch (err) {
      return this.fail(
        socket,
        'LIST_FAILED',
        err instanceof Error ? err.message : 'List processes failed',
        undefined,
        parsed.data.requestId,
      );
    }
  }

  @SubscribeMessage(WsEvent.LIST_APPS)
  async onListApps(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    if (socket.data.channel !== 'web-client' || !socket.data.userId) {
      return this.fail(socket, 'FORBIDDEN', 'LIST_APPS only for web-client');
    }
    if (!(await this.rateLimit(socket))) {
      return this.fail(socket, 'RATE_LIMITED', 'Too many messages');
    }
    const parsed = listQuerySchema.safeParse(body);
    if (!parsed.success) {
      return this.fail(socket, 'VALIDATION_ERROR', 'Invalid LIST_APPS', parsed.error.issues);
    }
    try {
      const result = await this.tasks.requestDeviceList(
        socket.data.userId,
        'LIST_APPS',
        parsed.data,
      );
      return { ok: true, ...result };
    } catch (err) {
      return this.fail(
        socket,
        'LIST_FAILED',
        err instanceof Error ? err.message : 'List apps failed',
        undefined,
        parsed.data.requestId,
      );
    }
  }

  // -------- shared --------

  @SubscribeMessage(WsEvent.PING)
  async onPing(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    const parsed = pingSchema.safeParse(body ?? {});
    const payload = parsed.success ? parsed.data : {};

    if (payload.nonce) {
      const claimed = this.pending.claimNonce(payload.nonce, 120);
      if (!claimed) {
        return this.fail(socket, 'REPLAY', 'Nonce already used', undefined, payload.requestId);
      }
    }

    this.connections.touchPong(socket.id);
    if (socket.data.deviceId) {
      await this.devices.touch(socket.data.deviceId);
    }

    const pong = {
      requestId: payload.requestId,
      serverTime: Date.now(),
    };
    socket.emit(WsEvent.PONG, pong);
    return { ok: true, ...pong };
  }

  @SubscribeMessage(WsEvent.PONG)
  onPong(@ConnectedSocket() socket: Socket) {
    this.connections.touchPong(socket.id);
  }

  /** Also accept envelope-style { event, payload } on "message" */
  @SubscribeMessage('message')
  async onEnvelope(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { event?: string; payload?: unknown },
  ) {
    if (!body?.event) {
      return this.fail(socket, 'VALIDATION_ERROR', 'Missing event');
    }
    switch (body.event) {
      case WsEvent.REGISTER_DEVICE:
        return this.onRegisterDevice(socket, body.payload);
      case WsEvent.SCREEN_RESULT:
        return this.onScreenResult(socket, body.payload);
      case WsEvent.ACTION_RESULT:
        return this.onActionResult(socket, body.payload);
      case WsEvent.NOTIFY_RESULT:
        return this.onNotifyResult(socket, body.payload);
      case WsEvent.PROCESSES_RESULT:
        return this.onProcessesResult(socket, body.payload);
      case WsEvent.APPS_RESULT:
        return this.onAppsResult(socket, body.payload);
      case WsEvent.CAPTURE_SCREEN:
        return this.onCaptureScreen(socket, body.payload);
      case WsEvent.USER_MESSAGE:
        return this.onUserMessage(socket, body.payload);
      case WsEvent.NOTIFY:
        return this.onNotify(socket, body.payload);
      case WsEvent.LIST_PROCESSES:
        return this.onListProcesses(socket, body.payload);
      case WsEvent.LIST_APPS:
        return this.onListApps(socket, body.payload);
      case WsEvent.PING:
        return this.onPing(socket, body.payload);
      case WsEvent.PONG:
        return this.onPong(socket);
      default:
        return this.fail(socket, 'UNKNOWN_EVENT', `Unknown event: ${body.event}`);
    }
  }

  private requireAgent(socket: Socket): boolean {
    return (
      socket.data.channel === 'desktop-agent' &&
      socket.data.authenticated === true &&
      typeof socket.data.deviceId === 'string'
    );
  }

  private async rateLimit(socket: Socket): Promise<boolean> {
    const app = this.config.get<AppConfig>('app')!;
    const key = socket.data.deviceId || socket.data.userId || socket.id;
    return this.pending.checkRateLimit(
      `ws:${key}`,
      app.WS_RATE_LIMIT_MAX,
      app.RATE_LIMIT_TTL_MS,
    );
  }

  private async enforceTimeouts(): Promise<void> {
    const app = this.config.get<AppConfig>('app')!;
    const stale = this.connections.getStaleSockets(app.CONNECTION_TIMEOUT_MS);
    for (const client of stale) {
      this.logger.warn(`Disconnecting stale socket ${client.socketId}`);
      this.server.sockets.sockets.get(client.socketId)?.disconnect(true);
    }
  }

  private emitError(socket: Socket, code: string, message: string): void {
    socket.emit(WsEvent.ERROR, { code, message });
  }

  /**
   * Explicitly emit ERROR with a real payload, then return a plain ack object.
   * Avoids Nest IoAdapter `{ event, payload }` → `emit(event, null)` bug.
   */
  private fail(
    socket: Socket,
    code: string,
    message: string,
    details?: unknown,
    requestId?: string,
  ) {
    const payload = { code, message, details, requestId };
    socket.emit(WsEvent.ERROR, payload);
    return { ok: false, ...payload };
  }
}
