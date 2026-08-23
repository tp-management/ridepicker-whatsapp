# RidePicker Backend

RidePicker backend v1 combines:

- Express REST API for the RidePicker frontend
- Baileys WhatsApp sessions
- QR pairing and phone-number pairing codes
- Supabase/PostgREST persistence
- encrypted Supabase persistence for Baileys credentials and Signal keys
- message deduplication and tracking gates
- controlled n8n forwarding
- legacy `/send` support for the existing n8n workflow

## Current architecture

```text
Firebase frontend
       ↓
Railway / this backend
       ↓
Supabase PostgreSQL + Vault
       ↓
Baileys / WhatsApp
       ↓
n8n AI parser
```

The backend is intentionally stateless with respect to its local filesystem. WhatsApp credentials, Signal keys, session state, messages, jobs, activity, and application data are persisted in Supabase. Active sockets, pairing codes, QR data, timers, and short-lived caches exist only in process memory and are rebuilt after restart.

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

### Phone-number pairing code

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

The response contains `session.pairingCode.code` only after the pairing request has passed the backend's acknowledgement checks. The customer opens WhatsApp → Linked Devices → Link a device → Link with phone number and enters the code.

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

When a QR exists, `session.qr.imageDataUrl` contains the current data URL.

## WhatsApp auth persistence

Baileys authentication is Supabase-only. `src/whatsapp/auth/supabaseAuthStore.js` stores both credential state and Signal keys through service-role-only RPC functions. Payloads are encrypted before they are stored in `public.whatsapp_auth`; the encryption key is held in Supabase Vault.

The runtime does not create or restore auth folders, JSON credential files, local databases, caches, or Railway-volume state. Obsolete local-storage environment variables are rejected at startup so an old deployment configuration cannot silently reactivate filesystem persistence.

## Environment

Copy `.env.example` to `.env` for local development if needed. A local `.env` is configuration input only; the application does not write runtime state to it or to any other local directory.

Required production values include:

```env
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
N8N_WEBHOOK_URL=...
FRONTEND_ORIGINS=https://ride-picker.web.app
N8N_FORWARD_SESSION_EVENTS=false
N8N_FORWARD_MEDIA_WITHOUT_TEXT=false
SESSION_POLICY_CACHE_MS=5000
```

Optional:

```env
INTERNAL_API_KEY=...
```

Do **not** configure a persistent Railway volume for WhatsApp auth. Do not add legacy local-auth directory settings. The service is designed to recover WhatsApp auth from Supabase after process or container replacement.

`SUPABASE_SERVICE_ROLE_KEY` is a server-only secret. Never put it in the Firebase/Vite frontend.

If `INTERNAL_API_KEY` is configured, the legacy `/send` and `/sessions` API requires the same value in `x-api-key` (or `x-ridepicker-key`). `/internal/jobs` always requires this key.

## Run locally

```bash
npm install
npm run check
npm test
npm run audit:stateless
npm run dev
```

`npm run audit:stateless` is a regression gate. It scans the production runtime for filesystem dependencies and deleted legacy auth/patch artifacts, verifies the Supabase-only auth boundary, checks repository metadata for old local-data conventions, and verifies that obsolete local-storage environment settings fail closed.

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

The existing contract is preserved:

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
    "direction": "incoming",
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

The user-facing authentication/ownership hardening is tracked separately from the WhatsApp storage refactor. Do not treat CORS or a frontend API key as user authentication.

DB-managed WhatsApp sessions use UUID session IDs from `public.whatsapp_sessions`.
