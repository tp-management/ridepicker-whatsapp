# RidePicker Backend

RidePicker backend v1 combines:

- Express REST API for the RidePicker frontend
- Baileys WhatsApp sessions
- QR pairing and phone-number pairing codes
- Supabase/PostgREST persistence
- message deduplication and tracking gates
- controlled n8n forwarding
- legacy `/send` support for the existing n8n workflow

## Current architecture

```text
Firebase frontend
       ↓
Railway / this backend
       ↓
Supabase PostgreSQL
       ↓
Baileys / WhatsApp
       ↓
n8n AI parser
```

## Important message behaviour

RidePicker does **not** forward raw WhatsApp noise to n8n anymore.

When RidePicker mode is `off`:

- incoming/outgoing WhatsApp messages are ignored by RidePicker
- nothing is written to `messages`
- nothing is forwarded to n8n

When RidePicker mode is `assist`:

- normal incoming + outgoing messages are stored in Supabase
- duplicate WhatsApp message IDs are ignored
- messages older than `bot_enabled_at` are ignored
- system/protocol/reaction events are ignored
- outgoing (`from_me`) messages are stored for conversation context but are **not** forwarded to n8n
- incoming text/caption messages are forwarded to n8n exactly once after a successful DB insert
- media-only messages are stored but are not sent to n8n by default
- session lifecycle events are not sent to n8n by default

All private chats and groups are monitored while Assist is active. There is no per-group enabled switch.

## WhatsApp pairing

Two connection methods are supported.

### Phone-number pairing code (recommended for mobile users)

The frontend already knows the RidePicker account phone. Calling:

```http
POST /api/users/:userId/whatsapp/pairing-code
Content-Type: application/json

{}
```

uses the RidePicker user's phone number by default.

To use a different WhatsApp number:

```json
{
  "phone": "+447700900123"
}
```

The response contains `session.pairingCode.code`.

The customer opens WhatsApp → Linked Devices → Link a device → Link with phone number and enters the code.

The existing Baileys `makeWASocket` options are intentionally unchanged. Pairing-code support is added only through `socket.requestPairingCode()`.

### QR fallback

```http
POST /api/users/:userId/whatsapp/start
Content-Type: application/json

{
  "method": "qr"
}
```

Poll:

```http
GET /api/users/:userId/whatsapp
```

When a QR exists, `session.qr.imageDataUrl` contains the real data URL. Baileys rotates QR codes automatically and the frontend simply keeps polling.

## Environment

Copy `.env.example` to `.env` locally.

The supplied `.env` intentionally has these values blank:

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

Fill them yourself.

`SUPABASE_SERVICE_ROLE_KEY` is a **server-only secret**. Never put it in the Firebase/Vite frontend.

### Local

```env
PORT=3001
DATA_DIR=./data
```

### Railway

Use a Railway Volume mounted at:

```text
/data
```

Set:

```env
DATA_DIR=/data
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
N8N_WEBHOOK_URL=...
FRONTEND_ORIGINS=https://ride-picker.web.app
N8N_FORWARD_SESSION_EVENTS=false
N8N_FORWARD_MEDIA_WITHOUT_TEXT=false
RESTORE_LEGACY_SESSIONS=false
SESSION_POLICY_CACHE_MS=5000
```

Do not manually set `PORT` on Railway unless necessary. Railway normally provides it.

Optional:

```env
INTERNAL_API_KEY=...
```

If `INTERNAL_API_KEY` is configured, the legacy `/send` and `/sessions` API requires the same value in `x-api-key` (or `x-ridepicker-key`). `/internal/jobs` always requires this key.

## Run locally

```bash
npm install
npm run check
npm run dev
```

Health:

```text
GET /health
```

Example response before Supabase values are filled:

```json
{
  "ok": true,
  "service": "ridepicker-whatsapp",
  "supabaseConfigured": false
}
```

## Main frontend API

See [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md).

Main areas:

- `/api/users/...` account lookup/signup/profile
- `/api/users/:userId/whatsapp...` WhatsApp connection lifecycle
- `/api/users/:userId/ridepicker` Assist OFF/ON state
- `/api/users/:userId/jobs...` job/payment/expense data
- `/api/users/:userId/activity` activity feed
- `/api/users/:userId/billing` billing data
- `/api/users/:userId/dashboard` calculated dashboard summary

## Existing n8n send endpoint

The old contract is preserved:

```http
POST /send
Content-Type: application/json

{
  "session": "<whatsapp-session-uuid>",
  "chatId": "<whatsapp-jid>",
  "text": "Hello"
}
```

Response:

```json
{
  "ok": true,
  "id": "..."
}
```

When Assist is on, the outgoing WhatsApp event created by `/send` is saved to Supabase for conversation context, but it is not sent back into n8n. This prevents reply loops.

## n8n incoming payload

Only a newly stored incoming message is sent by default:

```json
{
  "event": "message.received",
  "userId": "<ridepicker-user-uuid>",
  "session": "<whatsapp-session-uuid>",
  "timestamp": 1780000000000,
  "payload": {
    "id": "<whatsapp-message-id>",
    "dbMessageId": 123,
    "chatId": "...",
    "chatName": "London Chauffeur Jobs",
    "isGroup": true,
    "sender": "...",
    "senderName": "John",
    "participant": "...",
    "participantAlt": "...",
    "fromMe": false,
    "body": "LHR to Mayfair £95 tonight",
    "type": "text",
    "hasMedia": false,
    "media": null,
    "messageTimestamp": "2026-08-21T19:00:00.000Z"
  }
}
```

`dbMessageId` is important: n8n can use it as `source_message_id` when creating a parsed job.

## n8n job creation helper

A protected helper exists for the AI workflow:

```http
POST /internal/jobs
x-api-key: <INTERNAL_API_KEY>
Content-Type: application/json
```

```json
{
  "userId": "<uuid>",
  "sourceMessageId": 123,
  "jobs": [
    {
      "pickup": "LHR",
      "dropoff": "Mayfair",
      "pickupAt": "2026-08-22T06:30:00Z",
      "price": 95,
      "currency": "GBP",
      "vehicle": "E-Class",
      "confidence": 0.96,
      "originalMessage": "LHR to Mayfair £95 tomorrow 06:30"
    }
  ]
}
```

Each created job is linked to the source message and the message becomes `parsed`.

## Security note

The current frontend product flow identifies an account by phone number without OTP. That is fine for current development/demo work, but it is **not production authentication**.

Before onboarding real unrelated customers, add Supabase Auth phone OTP (or another real auth mechanism) and authorize user-specific API routes. CORS alone is not authentication.

## Legacy sessions

The old manual `/sessions` endpoints remain available for compatibility/debugging. `RESTORE_LEGACY_SESSIONS=false` is the safe default so old `dominykas`/`andrius` folders do not start producing unmanaged traffic after deployment.

DB-managed WhatsApp sessions use UUID session IDs from `public.whatsapp_sessions`.
