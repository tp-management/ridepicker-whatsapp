# RidePicker API contract

Base URL on production Railway:

```text
https://ridepicker-whatsapp-production.up.railway.app
```

The exact Railway domain can change; the frontend should use its configured API base URL.

## Account

### Lookup by phone

```http
GET /api/users/by-phone/+37067837730
```

```json
{
  "user": {
    "id": "uuid",
    "full_name": "Dominykas",
    "name": "Dominykas",
    "phone": "+37067837730",
    "email": "",
    "createdAt": "...",
    "profile": {
      "name": "Dominykas",
      "phone": "+37067837730",
      "email": ""
    }
  }
}
```

If not found:

```json
{ "user": null }
```

### Create account

```http
POST /api/users
```

```json
{
  "name": "John Smith",
  "phone": "+447700900123"
}
```

A new account automatically gets:

- empty driver preferences
- Premium subscription row in `payment_required`
- initial `Account created` activity

## Profile

```text
GET   /api/users/:userId/profile
PATCH /api/users/:userId/profile
```

PATCH body can include:

```json
{
  "name": "John Smith",
  "phone": "+447700900123",
  "email": "john@example.com"
}
```

## RidePicker mode

```text
GET /api/users/:userId/ridepicker
PUT /api/users/:userId/ridepicker
```

```json
{
  "mode": "assist"
}
```

`assist` requires:

- WhatsApp status `CONNECTED`
- active Premium subscription

`autopilot` is rejected while the feature is Coming Soon.

Response:

```json
{
  "mode": "assist",
  "botStartedAt": "2026-08-21T19:00:00Z"
}
```

## WhatsApp

### Current connection

```text
GET /api/users/:userId/whatsapp
```

Normalized response:

```json
{
  "session": {
    "sessionId": "uuid",
    "status": "starting|qr|connected|reconnecting|logged_out",
    "account": {
      "name": "John Chauffeur",
      "phone": "+447700900123"
    },
    "connectedAt": "...",
    "qr": null,
    "pairingCode": null
  }
}
```

### Start QR flow

```http
POST /api/users/:userId/whatsapp/start
```

```json
{ "method": "qr" }
```

### Phone pairing code

Recommended mobile flow:

```http
POST /api/users/:userId/whatsapp/pairing-code
```

Empty body uses the RidePicker login phone:

```json
{}
```

Different WhatsApp number:

```json
{
  "phone": "+447700900999"
}
```

Read:

```text
session.pairingCode.code
```

Then keep polling `GET /api/users/:userId/whatsapp` until `status=connected`.

### Refresh/recovery

```text
POST /api/users/:userId/whatsapp/refresh-qr
POST /api/users/:userId/whatsapp/reconnect
DELETE /api/users/:userId/whatsapp
```

A temporary reconnect does not change RidePicker mode.

## Jobs

```text
GET /api/users/:userId/jobs
GET /api/users/:userId/jobs/:jobId
```

Job shape is already frontend-friendly:

```json
{
  "id": "uuid",
  "pickup": "LHR",
  "dropoff": "Mayfair",
  "pickupTime": "2026-08-22T06:30:00Z",
  "price": 95,
  "currency": "GBP",
  "status": "won",
  "paymentStatus": "unpaid",
  "paymentMethod": "invoice",
  "vehicle": "E-Class",
  "passengers": 2,
  "flightNumber": null,
  "source": "London Chauffeur Jobs",
  "sender": "John",
  "originalMessage": "...",
  "expenses": [],
  "timeline": []
}
```

Update status:

```http
PATCH /api/users/:userId/jobs/:jobId/status
```

```json
{ "status": "completed" }
```

Update payment:

```http
PATCH /api/users/:userId/jobs/:jobId/payment
```

```json
{
  "paymentStatus": "paid",
  "paymentMethod": "card"
}
```

Add expense:

```http
POST /api/users/:userId/jobs/:jobId/expenses
```

```json
{
  "category": "parking",
  "amount": 18.5,
  "currency": "GBP",
  "note": "Heathrow parking"
}
```

Delete expense:

```text
DELETE /api/users/:userId/jobs/:jobId/expenses/:expenseId
```

## Dashboard

```text
GET /api/users/:userId/dashboard
```

Returns the existing `dashboard_summary` view in camelCase.

## Activity

```text
GET  /api/users/:userId/activity
POST /api/users/:userId/activity
```

Shape:

```json
{
  "id": "123",
  "time": "...",
  "type": "job|message|ridepicker|whatsapp",
  "title": "New job detected",
  "detail": "LHR → Mayfair",
  "jobId": "uuid"
}
```

## Billing

```text
GET  /api/users/:userId/billing
POST /api/users/:userId/billing/activate
POST /api/users/:userId/billing/cancel
POST /api/users/:userId/billing/reactivate
```

The current manual activate/reactivate endpoints are useful during development. Replace them with a real payment provider/webhook before production billing.
