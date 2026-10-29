# BIG MONEY Web Push (MVP)

Web Push is triggered **only after** `POST /internal/big-money-alerts` creates a new row. Duplicate calls keep the existing response and do not send another push. n8n sends `{ "userId": "...", "messageId": 42 }` with the configured `x-api-key`; the backend resolves the WhatsApp message and writes the existing `big_money_alerts` table.

## Setup (required before deployment)

1. Apply `supabase/migrations/20261029_big_money_push_subscriptions.sql` to the connected Supabase project.
2. Generate a P-256 VAPID key pair once, and set the following Railway environment variables. Do not regenerate after users subscribe:
   - `VAPID_PUBLIC_KEY`: base64url-encoded **uncompressed P-256 public key** (65 bytes).
   - `VAPID_PRIVATE_KEY`: base64url-encoded P-256 private scalar (32 bytes).
   - `VAPID_SUBJECT`: a contact URL, e.g. `mailto:notifications@yourdomain.example`.
   
   One-time key generation (Node 20+):
   ```bash
   node --input-type=module -e 'import {generateKeyPairSync} from "node:crypto";const k=generateKeyPairSync("ec",{namedCurve:"prime256v1"}).privateKey.export({format:"jwk"});console.log("VAPID_PUBLIC_KEY="+Buffer.concat([Buffer.from([4]),Buffer.from(k.x,"base64url"),Buffer.from(k.y,"base64url")]).toString("base64url")+"\\nVAPID_PRIVATE_KEY="+k.d)'
   ```
3. Deploy the backend and frontend branches after review; open RidePicker over HTTPS and click **Enable notifications**.
4. Close the browser tab; trigger a new BIG MONEY message through n8n; verify the system push. Clicking it opens `/home`, where the existing modal retrieves the pending alert.

The push has **no payload**, so the service worker displays only a generic alert, never confidential job text. This avoids new npm dependencies and preserves the existing popup.

**Security caveat before public rollout:** current RidePicker phone login/API uses a locally stored user ID without verified signed sessions. The new subscription registration route follows that existing model, so subscription-to-user binding is NOT securely authenticated. Add real OTP/session verification and authorize this route before enabling the feature for all customers. The endpoint is limited to known push-provider hosts to reduce SSRF risk.
