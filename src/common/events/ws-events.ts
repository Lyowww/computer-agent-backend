export enum WsEvent {
  REGISTER_DEVICE = 'REGISTER_DEVICE',
  DEVICE_REGISTERED = 'DEVICE_REGISTERED',
  DEVICE_STATUS = 'DEVICE_STATUS',
  CAPTURE_SCREEN = 'CAPTURE_SCREEN',
  SCREEN_RESULT = 'SCREEN_RESULT',
  CAPTURE_CAMERA = 'CAPTURE_CAMERA',
  CAMERA_RESULT = 'CAMERA_RESULT',
  EXECUTE_ACTION = 'EXECUTE_ACTION',
  ACTION_RESULT = 'ACTION_RESULT',
  TASK_START = 'TASK_START',
  TASK_UPDATE = 'TASK_UPDATE',
  TASK_COMPLETED = 'TASK_COMPLETED',
  TASK_FAILED = 'TASK_FAILED',
  USER_MESSAGE = 'USER_MESSAGE',
  AI_RESPONSE = 'AI_RESPONSE',
  ASK_USER = 'ASK_USER',
  NOTIFY = 'NOTIFY',
  NOTIFY_RESULT = 'NOTIFY_RESULT',
  LIST_PROCESSES = 'LIST_PROCESSES',
  PROCESSES_RESULT = 'PROCESSES_RESULT',
  LIST_APPS = 'LIST_APPS',
  APPS_RESULT = 'APPS_RESULT',
  OPEN_APP = 'OPEN_APP',
  CLOSE_APP = 'CLOSE_APP',
  APP_ACTION_RESULT = 'APP_ACTION_RESULT',
  LOCK_SCREEN = 'LOCK_SCREEN',
  UNLOCK_SCREEN = 'UNLOCK_SCREEN',
  LOCK_RESULT = 'LOCK_RESULT',
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
  deviceId?: string;
}

export interface ScreenResultPayload {
  requestId: string;
  taskId?: string;
  width?: number;
  height?: number;
  image?: string;
  mimeType?: string;
  error?: string;
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
  /** When false, forward as desktop notification only (no AI task). Default true. */
  useAi?: boolean;
}

export interface NotifyPayload {
  requestId: string;
  title?: string;
  body: string;
  from?: string;
  deviceId?: string;
}

export interface ListQueryPayload {
  requestId: string;
  deviceId?: string;
  limit?: number;
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
