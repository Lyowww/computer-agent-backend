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
import { RedisService } from '../common/redis/redis.module';
import { WsEvent } from '../common/events/ws-events';
import {
  actionResultSchema,
  captureScreenSchema,
  pingSchema,
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

@WebSocketGateway({
  cors: { origin: true, credentials: true },
  namespace: '/ws',
  transports: ['websocket', 'polling'],
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
    private readonly redis: RedisService,
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
        this.connections.register(socket, {
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
      return this.errorPayload('FORBIDDEN', 'REGISTER_DEVICE only for desktop-agent');
    }
    if (!(await this.rateLimit(socket))) {
      return this.errorPayload('RATE_LIMITED', 'Too many messages');
    }

    const parsed = registerDeviceWsSchema.safeParse(body);
    if (!parsed.success) {
      return this.errorPayload('VALIDATION_ERROR', 'Invalid REGISTER_DEVICE payload', parsed.error.issues);
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

      this.connections.register(socket, {
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

      const response = {
        event: WsEvent.DEVICE_REGISTERED,
        payload: {
          deviceId: device.id,
          name: online.name,
          os: online.os,
          connectionStatus: online.connectionStatus,
        },
      };
      socket.emit(WsEvent.DEVICE_REGISTERED, response.payload);
      return response;
    } catch (err) {
      return this.errorPayload(
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
      return this.errorPayload('UNAUTHORIZED', 'Device not registered');
    }
    if (!(await this.rateLimit(socket))) {
      return this.errorPayload('RATE_LIMITED', 'Too many messages');
    }

    const parsed = screenResultSchema.safeParse(body);
    if (!parsed.success) {
      return this.errorPayload('VALIDATION_ERROR', 'Invalid SCREEN_RESULT', parsed.error.issues);
    }

    await this.devices.touch(socket.data.deviceId);
    await this.tasks.handleScreenResult(parsed.data);
    return { event: 'ACK', payload: { requestId: parsed.data.requestId } };
  }

  @SubscribeMessage(WsEvent.ACTION_RESULT)
  async onActionResult(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    if (!this.requireAgent(socket)) {
      return this.errorPayload('UNAUTHORIZED', 'Device not registered');
    }
    if (!(await this.rateLimit(socket))) {
      return this.errorPayload('RATE_LIMITED', 'Too many messages');
    }

    const parsed = actionResultSchema.safeParse(body);
    if (!parsed.success) {
      return this.errorPayload('VALIDATION_ERROR', 'Invalid ACTION_RESULT', parsed.error.issues);
    }

    // Ownership: action's task must belong to this device
    const task = await this.prisma.task.findUnique({
      where: { id: parsed.data.taskId },
    });
    if (!task || task.deviceId !== socket.data.deviceId) {
      return this.errorPayload('FORBIDDEN', 'Action does not belong to this device');
    }

    await this.devices.touch(socket.data.deviceId);
    await this.tasks.handleActionResult(parsed.data);
    return { event: 'ACK', payload: { actionId: parsed.data.actionId } };
  }

  // -------- web-client events --------

  @SubscribeMessage(WsEvent.CAPTURE_SCREEN)
  async onCaptureScreen(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    if (socket.data.channel !== 'web-client' || !socket.data.userId) {
      return this.errorPayload('FORBIDDEN', 'CAPTURE_SCREEN only for web-client');
    }
    if (!(await this.rateLimit(socket))) {
      return this.errorPayload('RATE_LIMITED', 'Too many messages');
    }

    const parsed = captureScreenSchema.safeParse(body);
    if (!parsed.success) {
      return this.errorPayload('VALIDATION_ERROR', 'Invalid CAPTURE_SCREEN', parsed.error.issues);
    }

    try {
      const result = await this.tasks.captureScreenForUser(socket.data.userId, {
        requestId: parsed.data.requestId,
        quality: parsed.data.quality,
      });
      return { event: 'ACK', payload: result };
    } catch (err) {
      return this.errorPayload(
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
      return this.errorPayload('FORBIDDEN', 'USER_MESSAGE only for web-client');
    }
    if (!(await this.rateLimit(socket))) {
      return this.errorPayload('RATE_LIMITED', 'Too many messages');
    }

    const parsed = userMessageSchema.safeParse(body);
    if (!parsed.success) {
      return this.errorPayload('VALIDATION_ERROR', 'Invalid USER_MESSAGE', parsed.error.issues);
    }

    const result = await this.tasks.handleUserMessage(socket.data.userId, parsed.data);
    return { event: 'ACK', payload: { requestId: parsed.data.requestId, ...result } };
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
      const claimed = await this.redis.claimNonce(payload.nonce, 120);
      if (!claimed) {
        return this.errorPayload('REPLAY', 'Nonce already used', undefined, payload.requestId);
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
    return { event: WsEvent.PONG, payload: pong };
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
      return this.errorPayload('VALIDATION_ERROR', 'Missing event');
    }
    switch (body.event) {
      case WsEvent.REGISTER_DEVICE:
        return this.onRegisterDevice(socket, body.payload);
      case WsEvent.SCREEN_RESULT:
        return this.onScreenResult(socket, body.payload);
      case WsEvent.ACTION_RESULT:
        return this.onActionResult(socket, body.payload);
      case WsEvent.CAPTURE_SCREEN:
        return this.onCaptureScreen(socket, body.payload);
      case WsEvent.USER_MESSAGE:
        return this.onUserMessage(socket, body.payload);
      case WsEvent.PING:
        return this.onPing(socket, body.payload);
      case WsEvent.PONG:
        return this.onPong(socket);
      default:
        return this.errorPayload('UNKNOWN_EVENT', `Unknown event: ${body.event}`);
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
    return this.redis.checkRateLimit(
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

  private errorPayload(
    code: string,
    message: string,
    details?: unknown,
    requestId?: string,
  ) {
    return {
      event: WsEvent.ERROR,
      payload: { code, message, details, requestId },
    };
  }
}
