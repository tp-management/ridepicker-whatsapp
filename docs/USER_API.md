# RidePicker user API contract

This document maps the current public Supabase data model to the HTTP API used by the RidePicker frontend.

## Scope and trust boundary

The browser talks only to the RidePicker backend. Supabase service-role credentials never belong in the frontend.

`whatsapp_auth` and `system_logs` are intentionally **not** exposed through user-facing endpoints. `whatsapp_auth` contains transport credentials, while `system_logs` contains operational diagnostics rather than product data.

> Security blocker: `requireUser` currently verifies only that the target RidePicker user exists. Real Supabase Auth/JWT identity and ownership validation must be added before this API is treated as production-secure. Do not replace that work with a frontend API key.

## Database coverage

| Data | HTTP API |
| --- | --- |
| `users` | `GET /api/users/by-phone/:phone`, `POST /api/users`, `GET /api/users/:userId`, `GET/PATCH /api/users/:userId/profile` |
| `driver_preferences` | `GET/PATCH /api/users/:userId/preferences` |
| `whatsapp_sessions` | `GET /api/users/:userId/whatsapp`, pairing/start/reconnect/disconnect operations under the same resource |
| `whatsapp_chats` | `GET /api/users/:userId/whatsapp/chats` |
| `messages` | `GET /api/users/:userId/messages`, `GET /api/users/:userId/messages/:messageId`, chat-scoped message reads and sends |
| `jobs` | list/get/create/update/delete plus status/payment operations under `/api/users/:userId/jobs` |
| `job_messages` | `GET /api/users/:userId/jobs/:jobId/messages` |
| `job_expenses` | list/create/update/delete under `/api/users/:userId/jobs/:jobId/expenses` |
| `activity` | `GET/POST /api/users/:userId/activity` |
| `subscriptions` | `GET /api/users/:userId/billing`, activate/cancel/reactivate operations |
| `billing_invoices` | included in billing subscription reads and available directly at `GET /api/users/:userId/billing/invoices` |
| `dashboard_summary` | `GET /api/users/:userId/dashboard` |
| `whatsapp_auth` | private backend transport state, never user-facing |
| `system_logs` | private operational diagnostics, never user-facing |

## Messages

### List messages

`GET /api/users/:userId/messages`

Optional query parameters:

- `chatId`
- `limit` (bounded by the backend)
- `before` ISO timestamp
- `after` ISO timestamp
- `fromMe=true|false`
- `processingStatus=new|sent_to_ai|parsed|ignored|error`

`before` and `after` are mutually exclusive.

Response:

```json
{
  "messages": [
    {
      "id": "7",
      "whatsappMessageId": "...",
      "chatId": "...",
      "chatName": "...",
      "senderId": "...",
      "senderName": "...",
      "body": "...",
      "isGroup": false,
      "fromMe": false,
      "type": "text",
      "hasMedia": false,
      "media": null,
      "timestamp": "2026-08-23T01:00:00.000Z",
      "processingStatus": "new",
      "forwardedToN8nAt": null,
      "createdAt": "2026-08-23T01:00:00.000Z"
    }
  ]
}
```

### Chat history

`GET /api/users/:userId/whatsapp/chats/:chatId/messages`

Uses the same pagination/filter query parameters as the global message list.

### Send a text message

`POST /api/users/:userId/whatsapp/chats/:chatId/messages`

```json
{ "text": "Hello" }
```

The backend requires the user's WhatsApp session to be `CONNECTED` and uses the existing Baileys `sendText` path.

## Activity and persisted messages

`GET /api/users/:userId/activity` returns the normal `activity` rows plus persisted WhatsApp messages transformed into `type: "message"` activity entries. This matches the existing frontend Activity page and its Messages filter.

Use `?includeMessages=false` when only explicit `activity` table rows are required. `limit` is also supported and bounded by the backend.

## Driver preferences

The public API uses camelCase fields even though PostgreSQL uses snake_case:

```json
{
  "baseLocation": "London",
  "defaultVehicle": "Mercedes V-Class",
  "minimumJobPrice": 75,
  "preferredAreas": ["Heathrow"],
  "blockedAreas": [],
  "workingHours": {},
  "autopilotRules": {}
}
```

## Jobs

Existing list/get/status/payment/expense routes remain compatible with the frontend. The complete resource also exposes:

- `POST /api/users/:userId/jobs`
- `PATCH /api/users/:userId/jobs/:jobId`
- `DELETE /api/users/:userId/jobs/:jobId`
- `GET /api/users/:userId/jobs/:jobId/messages`
- `GET /api/users/:userId/jobs/:jobId/expenses`
- `PATCH /api/users/:userId/jobs/:jobId/expenses/:expenseId`

Database check constraints remain the source of truth for valid job status, payment status/method, confidence and expense categories; the API validates the user-editable forms before sending them to Supabase.

## Billing

The API exposes subscription state and stored invoice records. Payment-provider checkout creation is deliberately **not fabricated**. Until a provider is configured, the frontend must continue treating checkout as not configured rather than inventing a URL or payment result.
