# BIG MONEY Web Push: verified opt-in and retrying deliveries

The existing n8n workflow calls `POST /internal/big-money-alerts` with
`{ "userId": "...", "messageId": 42 }` and `x-api-key`. The backend snapshots
the raw WhatsApp message and inserts `big_money_alerts` as before.

A DB trigger **atomically** queues one delivery per subscribed browser in
`push_deliveries`. The existing Node backend runs a 2-second polling worker
that leases jobs across multiple instances (PostgreSQL `FOR UPDATE SKIP LOCKED`),
retries transient provider failures with backoff, and recovers expired leases after
a crash/restart. It skips accepted/declined and >15-minute-old offers.
A provider HTTP 2xx indicates acceptance, **not guaranteed user display**.
Timeout after provider acceptance can mean an occasional duplicate, by design.

## Deployment prerequisites (not yet applied)

1. Apply `supabase/migrations/20261029_big_money_push_subscriptions.sql`.
   This creates `push_subscriptions`, `push_deliveries`, trigger, and the
   `claim_pending_push_deliveries` RPC. Do not deploy backend before migration.
2. Enable **Supabase Auth Phone OTP** and configure an SMS provider in Supabase
   Dashboard. This is mandatory because current RidePicker phone login only
   looks up the account without verifying phone ownership.
3. Generate P-256 VAPID key pair ONCE; set these backend environment values:
   - `VAPID_PUBLIC_KEY` (base64url 65-byte uncompressed P-256 point)
   - `VAPID_PRIVATE_KEY` (base64url 32-byte P-256 private scalar)
   - `VAPID_SUBJECT` (e.g. `mailto:notifications@yourdomain.example`)
   - Existing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are required
   (never expose these secret values to the browser).
   
   Generate locally (Node 20+):
   ```bash
   node --input-type=module -e 'import {generateKeyPairSync} from "node:crypto";const k=generateKeyPairSync("ec",{namedCurve:"prime256v1"}).privateKey.export({format:"jwk"});console.log("VAPID_PUBLIC_KEY="+Buffer.concat([Buffer.from([4]),Buffer.from(k.x,"base64url"),Buffer.from(k.y,"base64url")]).toString("base64url")+"\\nVAPID_PRIVATE_KEY="+k.d)'
   ```
4. Review/merge and deploy both frontend and backend PRs.
5. User opens RidePicker Home → Enable notifications → receives OTP on **their
   RidePicker account phone** → enters 6-digit code → Allow notifications.
   Supabase Auth confirms the phone; backend checks it against `users.phone_e164`
   (and `auth_user_id` if present) before accepting a push endpoint.
6. Close browser tab, submit a **new** BIG MONEY message through n8n,
   and verify a native notification appears. Clicking opens `/home` and the
   existing BIG MONEY modal.

The push is intentionally payload-free. The service worker displays a generic
notice and does not expose the WhatsApp message until RidePicker opens.
Multiple notifications use separate OS entries, not a shared `tag`.

## Known scope / release gates

- Push opt-in is **verified**, but the legacy RidePicker phone-login and other
  user endpoints are **not**. Full product-wide authentication needs a separate
  migration to verified OTP sessions before a mass-production launch.
- OTP requests are limited by Supabase and a local in-process rate gate; a
  distributed rate limiter / CAPTCHA should be evaluated for mass scale.
- Browser/device notification permission, iOS Home Screen requirements, quiet
  mode and OS push delivery remain outside server control.
- Delivery jobs are persisted. After 8 failures they are marked `dead`
  (inspect `push_deliveries`), not silently discarded.
- Code/unit tests are not end-to-end device proof; production has not changed.
