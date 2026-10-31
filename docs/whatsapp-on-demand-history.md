# On-demand WhatsApp history (n8n)

This endpoint **does not store retrieved history** in Supabase or on disk.

```http
POST /internal/whatsapp/history
x-api-key: <WHATSAPP_HISTORY_API_KEY>
Content-Type: application/json

{
  "userId": "<RidePicker user UUID>",
  "sessionId": "<connected WhatsApp session UUID>",
  "chatId": "<exact WhatsApp JID>",
  "count": 50
}
```

- Set a dedicated `WHATSAPP_HISTORY_API_KEY` variable on the Railway backend and put the same secret into an n8n Header Auth credential.
- The backend uses **one existing** message in `messages` as an anchor; only its ID and timestamp are read. No history is imported or persisted.
- `chatId` alone is **not sufficient** for Baileys. When there is no anchor, the API returns HTTP 422. The caller may supply a previously returned `before` cursor to get the next older page.
- One request returns at most 50 WhatsApp messages, in ascending time order. Each includes `id`, `chatId`, `fromMe`, `participant`, `timestamp` and `text`. Media files are not downloaded.
- Example success: `{"chatId":"...","status":"received","messages":[...],"nextBefore":{...},"complete":false}`.
- Paginate by passing `"before": <previous nextBefore>` in a subsequent request.
- **HTTP 504** means WhatsApp did not send the history event; **never** interpret this as "no previous conversation". HTTP 422 means a usable anchor is absent; HTTP 409 means WhatsApp is offline or a request is running.
- `complete:false` is intentional: WhatsApp does not certify that all historical messages were returned.

**Privacy:** do not enable persistent n8n execution-data storage for workflow runs containing chat history. Keep any AI-processing payload transient. Existing RidePicker live message storage is unchanged; this feature adds no history storage.
