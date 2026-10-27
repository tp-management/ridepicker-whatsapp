import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createN8nDeliveryWorker,
  nextN8nDeliveryState,
} from "../src/n8nDeliveryWorker.js";

const noopLogger = { info() {}, warn() {}, error() {} };
const message = {
  id: "1234",
  user_id: "user-1",
  session_id: "session-1",
  whatsapp_message_id: "WA-1234",
  chat_id: "chat-1",
  chat_name: "Dispatcher",
  sender_id: "sender-1",
  sender_name: "John",
  body: "CM24 1QW to KY16\n£950",
  message_timestamp: "2026-10-28T00:00:00.000Z",
  n8n_attempt_count: 1,
};

test("2xx n8n ACK marks only delivery as delivered, keeping AI progress separate", async () => {
  const seen = { updates: [], calls: [] };
  const worker = createN8nDeliveryWorker({
    webhookUrl: "https://n8n.example/webhook/messages/process",
    workerId: "lease-A",
    now: () => new Date("2026-10-28T00:00:01.000Z"),
    claim: async (args) => {
      assert.equal(args.p_worker_id, "lease-A");
      return [message];
    },
    update: async (table, patch, filter) => {
      seen.updates.push({ table, patch, filter });
      return [{ id: message.id }];
    },
    fetchImpl: async (url, options) => {
      seen.calls.push({ url, options });
      return { ok: true, status: 202 };
    },
    logger: noopLogger,
  });

  await worker.processOnce();
  assert.equal(seen.calls.length, 1);
  assert.equal(seen.calls[0].url, "https://n8n.example/webhook/messages/process");
  assert.equal(seen.calls[0].options.headers["X-RidePicker-Message-Id"], "1234");
  const payload = JSON.parse(seen.calls[0].options.body);
  assert.equal(payload.message_id, "1234");
  assert.equal(payload.user_id, "user-1");
  assert.equal(payload.body, "CM24 1QW to KY16\n£950");
  assert.deepEqual(seen.updates[0].filter, {
    id: "eq.1234",
    n8n_delivery_status: "eq.delivering",
    n8n_locked_by: "eq.lease-A",
  });
  assert.equal(seen.updates[0].patch.n8n_delivery_status, "delivered");
  assert.equal(seen.updates[0].patch.forwarded_to_n8n_at, "2026-10-28T00:00:01.000Z");
  assert.equal(seen.updates[0].patch.processing_status, undefined);
});

test("5xx response schedules retry; no AI processing state is changed", async () => {
  const patches = [];
  const worker = createN8nDeliveryWorker({
    webhookUrl: "https://n8n.example/webhook/messages/process",
    claim: async () => [{ ...message, n8n_attempt_count: 2 }],
    update: async (_table, patch) => { patches.push(patch); return [{ id: 1234 }]; },
    fetchImpl: async () => ({ ok: false, status: 503 }),
    now: () => new Date("2026-10-28T00:00:00.000Z"),
    random: () => 0,
    logger: noopLogger,
  });
  await worker.processOnce();
  assert.equal(patches[0].n8n_delivery_status, "retry");
  assert.equal(patches[0].n8n_next_attempt_at, "2026-10-28T00:00:04.000Z");
  assert.equal(patches[0].n8n_last_error, "n8n returned HTTP 503");
  assert.equal(patches[0].processing_status, undefined);
});

test("temporarily inactive n8n webhook (404) retries instead of dying on first attempt", async () => {
  const base = { now: new Date("2026-10-28T00:00:00.000Z"), random: () => 0 };
  assert.deepEqual(
    (({ n8n_delivery_status, n8n_next_attempt_at }) => ({
      n8n_delivery_status, n8n_next_attempt_at,
    }))(nextN8nDeliveryState({ ...base, attemptCount: 1, httpStatus: 404 })),
    { n8n_delivery_status: "retry", n8n_next_attempt_at: "2026-10-28T00:00:02.000Z" },
  );
  assert.equal(nextN8nDeliveryState({ ...base, attemptCount: 7, httpStatus: 404 }).n8n_delivery_status, "retry");
  assert.equal(nextN8nDeliveryState({ ...base, attemptCount: 8, httpStatus: 404 }).n8n_delivery_status, "dead");

  const updates = [];
  const worker = createN8nDeliveryWorker({
    webhookUrl: "https://n8n.example/webhook/messages/process",
    claim: async () => [message],
    update: async (_table, patch) => { updates.push(patch); return [{ id: message.id }]; },
    fetchImpl: async () => ({ ok: false, status: 404 }),
    now: () => base.now,
    random: base.random,
    logger: noopLogger,
  });
  await worker.processOnce();
  assert.equal(updates[0].n8n_delivery_status, "retry");
  assert.equal(updates[0].n8n_last_error, "n8n returned HTTP 404");
});

test("401/403 retry with longer delays but stop after five attempts", () => {
  const base = { now: new Date("2026-10-28T00:00:00.000Z"), random: () => 0 };
  for (const httpStatus of [401, 403]) {
    const first = nextN8nDeliveryState({ ...base, attemptCount: 1, httpStatus });
    assert.equal(first.n8n_delivery_status, "retry");
    assert.equal(first.n8n_next_attempt_at, "2026-10-28T00:00:30.000Z");
    const fourth = nextN8nDeliveryState({ ...base, attemptCount: 4, httpStatus });
    assert.equal(fourth.n8n_delivery_status, "retry");
    assert.equal(fourth.n8n_next_attempt_at, "2026-10-28T00:04:00.000Z");
    const fifth = nextN8nDeliveryState({ ...base, attemptCount: 5, httpStatus });
    assert.equal(fifth.n8n_delivery_status, "dead");
    assert.equal(fifth.n8n_next_attempt_at, null);
  }
});

test("bad payload 400/422 die early, while transient failures retry up to max attempts", () => {
  const base = { now: new Date("2026-10-28T00:00:00.000Z"), random: () => 0 };
  for (const httpStatus of [400, 422]) {
    const outcome = nextN8nDeliveryState({ ...base, attemptCount: 1, httpStatus });
    assert.equal(outcome.n8n_delivery_status, "dead");
    assert.equal(outcome.n8n_next_attempt_at, null);
  }
  for (const httpStatus of [408, 429, 500, 502, 503, null]) {
    assert.equal(nextN8nDeliveryState({ ...base, attemptCount: 1, httpStatus }).n8n_delivery_status, "retry");
    const exhausted = nextN8nDeliveryState({ ...base, attemptCount: 8, httpStatus });
    assert.equal(exhausted.n8n_delivery_status, "dead");
    assert.equal(exhausted.n8n_next_attempt_at, null);
  }
});

test("worker never claims anything if no webhook URL is configured", async () => {
  let claims = 0;
  const worker = createN8nDeliveryWorker({
    webhookUrl: null,
    claim: async () => { claims++; return [message]; },
    logger: noopLogger,
  });
  await worker.processOnce();
  worker.start()();
  assert.equal(claims, 0);
});

test("outbox migration preserves permitted RAW messages and limits claim ownership", async () => {
  const migration = await readFile(
    "supabase/migrations/20261028_raw_message_n8n_delivery_outbox.sql", "utf8"
  );
  assert.match(migration, /DROP TRIGGER IF EXISTS filter_assist_keywords_before_insert/i);
  assert.match(migration, /DROP TRIGGER IF EXISTS b_drop_recent_duplicate_sender_messages/i);
  assert.doesNotMatch(migration, /DROP TRIGGER IF EXISTS messages_validate_tracking/i);
  assert.doesNotMatch(migration, /DROP TRIGGER IF EXISTS a_drop_blocked_assist_sender_messages/i);
  assert.match(migration, /FOR UPDATE OF m SKIP LOCKED/i);
  assert.match(migration, /n8n_locked_by = p_worker_id/i);
  assert.match(migration, /SECURITY INVOKER/i);
  assert.match(migration, /TO service_role/i);
  assert.match(migration, /forwarded_to_n8n_at IS NOT NULL AND n8n_delivery_status IS NULL/i);
});

test("OFF and re-enabled policies terminally skip queued messages without deleting RAW history", async () => {
  const migration = await readFile(
    "supabase/migrations/20261028_raw_message_n8n_delivery_outbox.sql", "utf8"
  );
  assert.match(migration, /'pending','delivering','delivered','retry','dead','skipped'/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS n8n_skipped_at timestamptz/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS n8n_skip_reason text/i);
  const cleanupStart = migration.indexOf("WITH stale AS (");
  const claimStart = migration.indexOf("RETURN QUERY", cleanupStart);
  assert.ok(cleanupStart > 0, "queue cleanup must exist");
  assert.ok(claimStart > cleanupStart, "cleanup must execute before the next delivery claim");
  const cleanup = migration.slice(cleanupStart, claimStart);
  assert.match(cleanup, /ws\.bot_mode\s*=\s*'off'/i);
  assert.match(cleanup, /m\.message_timestamp\s*<\s*ws\.bot_enabled_at/i);
  assert.match(cleanup, /m\.n8n_delivery_status IN \('pending','retry'\)/i);
  assert.match(cleanup, /m\.n8n_delivery_status = 'delivering'/i);
  assert.match(cleanup, /m\.n8n_locked_at\s*<\s*now\(\)\s*-\s*make_interval/i);
  assert.match(cleanup, /FOR UPDATE OF m SKIP LOCKED/i);
  assert.match(cleanup, /LIMIT 100/i);
  assert.match(cleanup, /n8n_delivery_status\s*=\s*'skipped'/i);
  assert.match(cleanup, /n8n_next_attempt_at\s*=\s*NULL/i);
  assert.match(cleanup, /n8n_locked_by\s*=\s*NULL/i);
  assert.match(cleanup, /n8n_skip_reason\s*=\s*stale\.reason/i);
  assert.doesNotMatch(cleanup, /DELETE FROM public\.messages/i);
  assert.doesNotMatch(cleanup, /processing_status\s*=/i);
});

test("WhatsApp notification handler persists RAW and pending in one insert", async () => {
  const source = await readFile("src/whatsapp.js", "utf8");
  const begin = source.indexOf("async function processMessage(");
  const end = source.indexOf("export function getSession(", begin);
  assert.ok(begin > 0 && end > begin);
  const handler = source.slice(begin, end);
  assert.match(handler, /n8n_delivery_status: eligibleForAi \? "pending" : null/i);
  assert.match(handler, /processing_status: eligibleForAi \? "new" : "ignored"/i);
  assert.doesNotMatch(handler, /await sendToN8n\(/);
  assert.match(handler, /repository\.insertMessage\(/);
});
