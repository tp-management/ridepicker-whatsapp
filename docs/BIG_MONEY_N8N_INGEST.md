# n8n → BIG MONEY ingest

## Endpoint

**POST** \`https://ridepicker-whatsapp-production.up.railway.app/internal/big-money-alerts\`

Headers:

- \`Content-Type: application/json\`
- \`x-api-key: <BIG_MONEY_INGEST_KEY>\` (store as an n8n credential, not in workflow JSON or logs)

JSON body:

\`\`\`json
{
  "userId": "<RidePicker users.id UUID>",
  "messageId": 12345
}
\`\`\`

Use the numeric \`public.messages.id\` (not the WhatsApp message JID).
The backend fetches the original WhatsApp message from Supabase and checks that it belongs to the supplied user's WhatsApp session before INSERT. It preserves the original message, ignores duplicate requests, and the database trigger sends Web Push separately.

Responses:
- \`201 {"ok":true,"created":true}\` inserted a new alert.
- \`200 {"ok":true,"created":false}\` already processed.
- \`401\` missing/invalid key.
- \`404\` no matching message or message from another user's WhatsApp session.
- \`400\` invalid body.

## Important separation

\`BIG_MONEY_INGEST_KEY\` is a **shared server-to-server credential**, not an end-user key or a Supabase service_role key. It authenticates n8n as an allowed caller; the \`userId\` is per request and the backend checks message ownership.

It is separate from:
- \`BIG_MONEY_WEBHOOK_SECRET\`, used for Supabase pg_net → backend on \`/internal/big-money-inserted\`.
- \`INTERNAL_API_KEY\`, the legacy backend key for \`/send\`, \`/sessions\` and other internal endpoints. Setting this legacy key on the production service can break existing n8n WhatsApp reply flows that don't send it.

The BIG MONEY route accepts \`BIG_MONEY_INGEST_KEY\` when set and falls back to \`INTERNAL_API_KEY\` only for legacy configurations. Never commit either secret. Configure it in the Railway production service and in the n8n credential for just this HTTP Request node.
