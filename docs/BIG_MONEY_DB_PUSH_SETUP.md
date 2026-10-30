# BIG MONEY DB-triggered Web Push (RidePicker)

Owner: **Aras | RidePicker Lead Developer**. The n8n workflow remains under the product owner's control; these steps do not change n8n.

## Pipeline

Any **new** pending row in public.big_money_alerts, whether inserted via n8n, SQL Editor or backend, triggers a Supabase pg_net callback **after the transaction commits**:

- Backend POST /internal/big-money-inserted validates the shared secret and rereads the actual DB row (ID, owner, pending status).
- Backend sends a Web Push to registered devices and publishes an SSE invalidation for open RidePicker tabs.
- The existing BIG MONEY popup remains backed by public.big_money_alerts. ACCEPT/DECLINE only records the driver's decision.
- Existing rows do not retrigger, and accepted/declined rows are excluded.
- MVP delivery is **best effort**. pg_net doesn't guarantee a retry and this PR intentionally doesn't add an outbox. Don't claim end-to-end delivery until a real device confirms it.

## Required one-time production settings

The code and DB migration can be installed safely before keys exist; in that state inserts continue but no Push is sent.

1. Generate a fresh unique random 32-byte token on your own computer, e.g.:
   \`openssl rand -hex 32\`

2. In the Railway **ridepicker-whatsapp production service**, add:
   \`BIG_MONEY_WEBHOOK_SECRET=<generated token>\`
   Apply the environment changes/deploy. **Only the project owner changes Railway variables.** Do not screenshot or paste this key into a public repository.

3. In [Supabase SQL Editor](https://supabase.com/dashboard/project/gozmjyksnzjhehhnnvon/sql/new), save the same token once in Vault (replace the placeholder locally):
   \`select vault.create_secret('PASTE_SAME_TOKEN_HERE', 'ridepicker_big_money_webhook_secret');\`

4. Configure the full callback URL in Supabase Vault as a separate setting:
   \`select vault.create_secret('https://ridepicker-whatsapp-production.up.railway.app/internal/big-money-inserted', 'ridepicker_big_money_webhook_url');\`

   This is configuration, *not a SQL function hardcode*. Change the stored Vault value if the backend address changes. Only use a verified production backend URL.

5. Apply the migration \`20261030_big_money_db_triggered_push.sql\` (Aras runs and verifies it).
   Migration creates pg_net and a trigger only; it never backfills old alerts.

## Verification

- Open RidePicker in a regular browser, enable notifications, and confirm \`push_subscriptions\` has at least one endpoint for your user.
- Submit a fresh **pending** BIG MONEY alert for that user, using the same method that currently creates alerts. Don't modify historical alerts for a test. Your n8n can remain untouched.
- Confirm both: the open app sees the original-message popup; an actual installed/authorized phone (or desktop browser) receives a native Push while the app is in the background.
- If Push fails, inspect backend log \`[big-money-push]\` and Supabase pg_net response diagnostics (do not expose secret headers). The DB alert should still exist.
- Don't deploy this migration before the corresponding backend release if the secret is already configured.

## Important

The Push subscription count can be nonzero without proving Push delivery. The backend and database can only confirm request attempts, not operating-system presentation without a device check. No extra SMS/OTP or changes to n8n are required.
