# Computer Agent Backend

NestJS backend that coordinates the **web client**, **AI service**, and **desktop agents** for remote AI computer control.

```
Web Client  →  Backend  →  AI Service
                 ↕
           Desktop Agent
```

This repository is backend-only. It does **not** include a frontend, desktop app, or AI model implementation.

## Features

- JWT user authentication
- Secure device provisioning (one-time device tokens; never re-exposed to the browser)
- Dual WebSocket channels: `web-client` and `desktop-agent`
- Task orchestration with lifecycle states
- Screenshot relay (ephemeral Redis buffer; no permanent storage by default)
- AI service adapter with action validation
- Action history for debugging
- Rate limiting, ownership checks, replay protection (nonce), connection timeouts
- PostgreSQL + Prisma, Redis, Docker Compose

## Tech stack

Node.js · TypeScript · NestJS · Socket.IO · PostgreSQL · Prisma · Redis · JWT · Zod · Jest

## Quick start

### 1. Prerequisites

- Node.js 20+
- Docker & Docker Compose (for Postgres + Redis)

### 2. Start infrastructure

```bash
cp .env.example .env
docker compose up -d postgres redis
```

Postgres is published on host port **5433** (avoids conflicts with other local Postgres containers on `5432`). Match that in `DATABASE_URL`.

### 3. Install & migrate

```bash
npm install
npx prisma generate
npx prisma migrate deploy
npm run db:seed   # optional demo user: demo@example.com / password123
```

### 4. Run the API

```bash
npm run start:dev
```

- REST: `http://localhost:3000/api`
- Health: `http://localhost:3000/api/health`
- WebSocket: `ws://localhost:3000/ws`

### Full stack via Docker

```bash
cp .env.example .env
docker compose up --build
```

## Environment

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `JWT_SECRET` | JWT signing secret (min 16 chars) |
| `AI_SERVICE_URL` | Base URL of the external AI planner |
| `PORT` | HTTP/WS port (default `3000`) |
| `STORE_SCREENSHOTS` | If `true`, keep screenshots in Redis for `SCREENSHOT_TTL_SECONDS` |
| `MAX_TASK_ITERATIONS` | Cap AI/action loops per task |
| `CONNECTION_TIMEOUT_MS` | Stale WebSocket disconnect threshold |

Never commit `.env` secrets.

## REST API

All routes are under `/api` and require `Authorization: Bearer <jwt>` unless noted.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/register` | Create account |
| `POST` | `/auth/login` | Login → `{ accessToken, user }` |
| `GET` | `/users/me` | Current user |
| `POST` | `/devices` | Provision device → returns **one-time** `deviceToken` |
| `GET` | `/devices` | List devices (no tokens) |
| `GET` | `/devices/:id` | Device detail |
| `POST` | `/devices/:id/revoke` | Revoke device |
| `POST` | `/tasks` | Create & start task `{ instruction, deviceId }` |
| `GET` | `/tasks` | List tasks |
| `GET` | `/tasks/:id` | Task + actions + chat |
| `POST` | `/tasks/:id/cancel` | Cancel task |
| `GET` | `/chat/history` | Chat history (`?taskId=&limit=`) |
| `GET` | `/health` | Liveness (public) |

### Example: login & provision device

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","password":"password123"}' | jq -r .accessToken)

curl -s -X POST http://localhost:3000/api/devices \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"My Mac","os":"darwin"}'
# → { device, deviceToken }  ← store deviceToken only on the desktop agent
```

## WebSocket protocol

Connect to namespace `/ws` with query `channel`:

### Web client

```
io('http://localhost:3000/ws', {
  query: { channel: 'web-client' },
  auth: { token: '<JWT>' }
})
```

### Desktop agent

```
io('http://localhost:3000/ws', {
  query: { channel: 'desktop-agent' }
})
// then emit REGISTER_DEVICE with deviceToken
```

Unauthenticated browsers cannot talk to desktop agents. Agents authenticate with a **device token**, not a user JWT alone.

### Events

| Event | Direction | Notes |
|-------|-----------|-------|
| `REGISTER_DEVICE` | Agent → Backend | `{ deviceToken, deviceName, os }` |
| `DEVICE_REGISTERED` | Backend → Agent | Confirms registration |
| `DEVICE_STATUS` | Backend → Web | Online/offline updates |
| `CAPTURE_SCREEN` | Backend → Agent / Web → Backend | Requires `requestId` |
| `SCREEN_RESULT` | Agent → Backend → Web/AI | Ephemeral; not stored in Postgres |
| `EXECUTE_ACTION` | Backend → Agent | Requires `actionId` + `taskId` |
| `ACTION_RESULT` | Agent → Backend | Requires `actionId` + `taskId` |
| `TASK_START` / `TASK_UPDATE` / `TASK_COMPLETED` / `TASK_FAILED` | Backend → Web | Lifecycle |
| `USER_MESSAGE` | Web → Backend | Chat / new task |
| `AI_RESPONSE` | Backend → Web | AI message + planned actions |
| `ERROR` | Backend → * | `{ code, message, requestId? }` |
| `PING` / `PONG` | Bidirectional | Optional `nonce` for replay protection |

Envelope form is also supported:

```json
{ "event": "CAPTURE_SCREEN", "payload": { "requestId": "req_123", "quality": 80 } }
```

## Task lifecycle

`CREATED` → `RUNNING` → `WAITING_FOR_SCREEN` → (AI) → `WAITING_FOR_ACTION` → … → `COMPLETED` | `FAILED` | `CANCELLED`

Also: `WAITING_FOR_USER` when the AI needs clarification.

## AI integration

Backend `POST`s to `{AI_SERVICE_URL}/v1/plan`:

```json
{
  "taskId": "...",
  "userInstruction": "...",
  "screenshot": { "width": 1920, "height": 1080, "image": "..." },
  "previousActions": []
}
```

Expected response (validated with Zod):

```json
{
  "taskId": "...",
  "status": "continue|completed|failed|need_user",
  "message": "...",
  "actions": [
    { "type": "CLICK", "params": { "x": 100, "y": 200 } }
  ]
}
```

Allowed action types: `CLICK`, `DOUBLE_CLICK`, `RIGHT_CLICK`, `TYPE`, `KEY`, `SCROLL`, `MOVE`, `DRAG`, `WAIT`, `LOCK_SCREEN`, `UNLOCK_SCREEN`, `DONE`, `FAIL`.

The backend **never** executes computer actions and **never** accepts arbitrary shell/exec commands from clients or AI responses.

## Security highlights

- Device auth via hashed tokens (`bcrypt`); prefix index for lookup
- Device tokens returned once at provisioning; revoke rotates the hash
- Task & device ownership checks on every sensitive path
- Max task iterations
- HTTP throttling + WebSocket rate limits (Redis)
- Nonce replay protection on `PING`
- Connection timeout / stale socket disconnect
- Helmet, Zod validation, JWT on REST + web-client WS

## Project structure

```
src/
  auth/          JWT login/register
  users/
  devices/       Provisioning & token auth
  sessions/      DeviceSession records
  websocket/     Gateway + connection registry
  tasks/         Orchestration
  ai/            AI HTTP adapter
  actions/       TaskAction history
  screenshots/   Ephemeral Redis buffer
  chat/
  database/      Prisma
  common/        crypto, guards, validation, redis, events
  config/
  main.ts
```

## Tests

```bash
npm test
npm run test:e2e
```

## Connecting other repos

1. **Web client** — REST + WS `channel=web-client` with user JWT  
2. **Desktop agent** — provision via `POST /devices`, store `deviceToken` locally, WS `channel=desktop-agent` + `REGISTER_DEVICE`  
3. **AI service** — implement `POST /v1/plan` matching the contract above  

## License

MIT
