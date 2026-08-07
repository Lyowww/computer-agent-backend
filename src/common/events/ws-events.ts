export enum WsEvent {
  REGISTER_DEVICE = 'REGISTER_DEVICE',
  DEVICE_REGISTERED = 'DEVICE_REGISTERED',
  DEVICE_STATUS = 'DEVICE_STATUS',
  CAPTURE_SCREEN = 'CAPTURE_SCREEN',
  SCREEN_RESULT = 'SCREEN_RESULT',
  EXECUTE_ACTION = 'EXECUTE_ACTION',
  ACTION_RESULT = 'ACTION_RESULT',
  TASK_START = 'TASK_START',
  TASK_UPDATE = 'TASK_UPDATE',
  TASK_COMPLETED = 'TASK_COMPLETED',
  TASK_FAILED = 'TASK_FAILED',
  USER_MESSAGE = 'USER_MESSAGE',
  AI_RESPONSE = 'AI_RESPONSE',
  ERROR = 'ERROR',
  PING = 'PING',
  PONG = 'PONG',
}

export type WsChannel = 'web-client' | 'desktop-agent';

export interface WsEnvelope<T = unknown> {
  event: WsEvent | string;
  payload: T;
  requestId?: string;
  timestamp?: number;
}

export interface RegisterDevicePayload {
  deviceToken: string;
  deviceName: string;
  os: 'darwin' | 'win32' | 'linux';
}

export interface CaptureScreenPayload {
  requestId: string;
  quality?: number;
  taskId?: string;
}

export interface ScreenResultPayload {
  requestId: string;
  taskId?: string;
  width: number;
  height: number;
  image: string;
  mimeType?: string;
}

export interface ExecuteActionPayload {
  actionId: string;
  taskId: string;
  type: string;
  params: Record<string, unknown>;
}

export interface ActionResultPayload {
  actionId: string;
  taskId: string;
  success: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

export interface TaskStartPayload {
  taskId: string;
  instruction: string;
  deviceId: string;
}

export interface TaskUpdatePayload {
  taskId: string;
  status: string;
  iteration?: number;
  message?: string;
}

export interface UserMessagePayload {
  requestId?: string;
  taskId?: string;
  content: string;
  deviceId?: string;
}

export interface AiResponsePayload {
  taskId: string;
  content: string;
  actions?: unknown[];
}

export interface ErrorPayload {
  code: string;
  message: string;
  requestId?: string;
  taskId?: string;
}

export interface PingPayload {
  requestId?: string;
  nonce?: string;
}
