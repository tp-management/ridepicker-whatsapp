# Frontend adapter map

The exported Firebase frontend already has these interfaces. The real API adapters can map directly to this backend.

## authService

- `lookupByPhone(phone)` → `GET /api/users/by-phone/:phone`
- `openExistingAccount(phone)` → same lookup, persist returned user locally until real OTP exists
- `signUp({name, phone})` → `POST /api/users`
- `getSession()` → current client session storage until Supabase Auth is added
- `logout()` → clear client session

## profileService

- `get(userId)` → `GET /api/users/:userId/profile`
- `update(userId, profile)` → `PATCH /api/users/:userId/profile`

## ridePickerService

- `getState(userId)` → `GET /api/users/:userId/ridepicker`
- `setMode(userId, mode)` → `PUT /api/users/:userId/ridepicker`

## whatsappService

- `getSession(userId)` → `GET /api/users/:userId/whatsapp`
- `refreshSession(userId)` → same GET
- `startSession(userId)` → recommended: `POST /api/users/:userId/whatsapp/pairing-code`
- QR fallback → `POST /api/users/:userId/whatsapp/start` with `{method:"qr"}`
- `refreshQr(userId)` → `POST /api/users/:userId/whatsapp/refresh-qr`
- `disconnect(userId)` → `DELETE /api/users/:userId/whatsapp`
- `retryReconnect(userId)` → `POST /api/users/:userId/whatsapp/reconnect`

For a mobile-first pairing screen, display `session.pairingCode.code` rather than QR by default.

## jobsService

- `list(userId)` → `GET /api/users/:userId/jobs`
- `get(userId, jobId)` → `GET /api/users/:userId/jobs/:jobId`
- `updateStatus(...)` → status PATCH
- `updatePayment(...)` → payment PATCH
- `addExpense(...)` → expense POST
- `removeExpense(...)` → expense DELETE

## activityService

- `list(userId)` → GET activity
- `add(userId, entry)` → POST activity

## billingService

- `getSubscription(user)` → GET billing and return `.subscription`

Real checkout should later be a payment-provider URL/webhook flow rather than trusting client-side billing mutations.
