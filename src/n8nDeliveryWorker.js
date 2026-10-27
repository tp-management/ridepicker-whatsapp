import { randomUUID } from "node:crypto";
import { N8N_WEBHOOK_URL } from "./config.js";
import { callRpc, updateRows } from "./supabase.js";

const POLL_MS = 2_000;
const HTTP_TIMEOUT_MS = 15_000;
const LEASE_SECONDS = 60;
const MAX_ATTEMPTS = 8;

export function nextN8nDeliveryState({
  attemptCount,
  httpStatus = null,
  errorMessage = "",
  now = new Date(),
  random = Math.random,
}) {
  const attempt = Math.max(1, Number(attemptCount) || 1);
  // Most client errors are not transient: bad credentials/payloads need
  // operator attention. 408 and 429 can recover, as can server/network errors.
  const permanent = httpStatus >= 400 && httpStatus < 500
    && httpStatus !== 408 && httpStatus !== 429;
  const dead = permanent || attempt >= MAX_ATTEMPTS;
  const delayMs = Math.min(10 * 60_000, 2_000 * 2 ** Math.min(attempt - 1, 9));
  const jitter = Math.floor(Math.max(0, random()) * 1_000);

  return {
    n8n_delivery_status: dead ? "dead" : "retry",
    n8n_next_attempt_at: dead
      ? null
      : new Date(new Date(now).getTime() + delayMs + jitter).toISOString(),
    n8n_last_error: String(errorMessage || "Delivery failed").slice(0, 1_000),
    n8n_locked_at: null,
    n8n_locked_by: null,
  };
}

export function createN8nDeliveryWorker({
  webhookUrl = N8N_WEBHOOK_URL,
  webhookSecret = process.env.N8N_WEBHOOK_SECRET || "",
  claim = (input) => callRpc("claim_pending_n8n_messages", input),
  update = updateRows,
  fetchImpl = fetch,
  workerId = randomUUID(),
  now = () => new Date(),
  random = Math.random,
  logger = console,
} = {}) {
  let busy = false;

  const updateClaimed = async (row, patch) => {
    // The lease owner fences late completions from a crashed/stalled worker.
    const updated = await update("messages", patch, {
      id: `eq.${row.id}`,
      n8n_delivery_status: "eq.delivering",
      n8n_locked_by: `eq.${workerId}`,
    });
    if (!Array.isArray(updated) || !updated.length) {
      logger.warn("[n8n-outbox] lease lost before acknowledgement", { messageId: row.id });
    }
  };

  const deliver = async (row) => {
    let response;
    let errorMessage = "";
    let httpStatus = null;
    const payload = {
      message_id: row.id,
      user_id: row.user_id,
      session_id: row.session_id,
      chat_id: row.chat_id,
      chat_name: row.chat_name,
      sender_id: row.sender_id,
      sender_name: row.sender_name,
      whatsapp_message_id: row.whatsapp_message_id,
      body: row.body,
      timestamp: row.message_timestamp,
    };
    try {
      const headers = {
        "Content-Type": "application/json",
        "X-RidePicker-Message-Id": String(row.id),
      };
      if (webhookSecret) headers["X-RidePicker-Key"] = webhookSecret;
      response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      httpStatus = Number(response.status);
      if (!response.ok) errorMessage = `n8n returned HTTP ${httpStatus}`;
    } catch (error) {
      errorMessage = error?.name === "TimeoutError"
        ? "n8n request timed out"
        : String(error?.message || error);
    }

    if (response?.ok) {
      await updateClaimed(row, {
        n8n_delivery_status: "delivered",
        forwarded_to_n8n_at: new Date(now()).toISOString(),
        n8n_last_error: null,
        n8n_next_attempt_at: null,
        n8n_locked_at: null,
        n8n_locked_by: null,
      });
      // ACK only proves acceptance, not that AI has finished.
      return "delivered";
    }

    const patch = nextN8nDeliveryState({
      attemptCount: row.n8n_attempt_count,
      httpStatus,
      errorMessage,
      now: now(),
      random,
    });
    await updateClaimed(row, patch);
    logger.warn("[n8n-outbox] delivery failed", {
      messageId: row.id,
      status: patch.n8n_delivery_status,
      attempt: row.n8n_attempt_count,
      httpStatus,
    });
    return patch.n8n_delivery_status;
  };

  const processOnce = async () => {
    if (busy || !webhookUrl) return [];
    busy = true;
    try {
      const rows = await claim({
        p_worker_id: workerId,
        p_batch_size: 5,
        p_lease_seconds: LEASE_SECONDS,
      });
      if (!Array.isArray(rows) || !rows.length) return [];
      // All settled avoids leaving claimed rows behind when one DB update fails.
      return await Promise.allSettled(rows.map(deliver));
    } catch (error) {
      logger.error("[n8n-outbox] delivery scan failed:", error?.message || error);
      return [];
    } finally {
      busy = false;
    }
  };

  const start = () => {
    if (!webhookUrl) {
      logger.info("[n8n-outbox] disabled: N8N_WEBHOOK_URL not configured");
      return () => {};
    }
    void processOnce();
    const timer = setInterval(() => { void processOnce(); }, POLL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  };

  return { processOnce, start, workerId };
}

export function startN8nDeliveryWorker() {
  return createN8nDeliveryWorker().start();
}
