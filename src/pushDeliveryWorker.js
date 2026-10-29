import { randomUUID } from "node:crypto";
import { callRpc, deleteRows, selectRows, updateRows } from "./supabase.js";
import { pushConfigured, pushConfiguration, validPushEndpoint, vapidAuthorization } from "./pushNotifications.js";

const POLL_MS = 2_000;
const MAX_ATTEMPTS = 8;
const ALERT_MAX_AGE_MS = 15 * 60_000;

export function nextPushDeliveryState(attemptCount, errorMessage, httpStatus = null, now = Date.now(), random = Math.random) {
  const attempt = Math.max(1, Number(attemptCount) || 1);
  const retry = attempt < MAX_ATTEMPTS && (httpStatus == null || httpStatus === 429 || httpStatus >= 500 || httpStatus === 401 || httpStatus === 403);
  const delayMs = Math.min(120_000, 2_000 * 2 ** Math.min(attempt - 1, 6)) + Math.floor(random() * 800);
  return {
    status: retry ? "retry" : "dead",
    next_attempt_at: retry ? new Date(now + delayMs).toISOString() : null,
    last_error: String(errorMessage || "Push delivery failed").slice(0, 500),
    last_http_status: httpStatus,
    locked_at: null,
    locked_by: null,
  };
}

export async function sendPayloadFreePush(endpoint, config, fetchImpl = fetch) {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      TTL: "300",
      Urgency: "high",
      Authorization: vapidAuthorization(endpoint, config),
    },
    body: new Uint8Array(0),
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  return Number(response.status);
}

export function createPushDeliveryWorker({
  claim = (params) => callRpc("claim_pending_push_deliveries", params),
  select = selectRows,
  update = updateRows,
  remove = deleteRows,
  send = sendPayloadFreePush,
  config = pushConfiguration(),
  now = () => Date.now(),
  random = Math.random,
  logger = console,
  workerId = randomUUID(),
} = {}) {
  let busy = false;
  const updateClaimed = async (row, patch) => {
    const updated = await update("push_deliveries", patch, {
      id: "eq." + row.id,
      status: "eq.sending",
      locked_by: "eq." + workerId,
    });
    if (!Array.isArray(updated) || updated.length === 0) {
      logger.warn("[push-outbox] lease lost", { deliveryId: row.id });
    }
  };

  const mark = (row, status) => updateClaimed(row, {
    status,
    next_attempt_at: null,
    locked_at: null,
    locked_by: null,
    ...(status === "delivered" ? { delivered_at: new Date(now()).toISOString(), last_error: null } : {}),
  });

  const deliver = async (row) => {
    let status = null;
    try {
      const subs = await select("push_subscriptions", {
        select: "id,endpoint",
        id: "eq." + row.subscription_id,
        user_id: "eq." + row.user_id,
        limit: 1,
      });
      if (!subs.length || !validPushEndpoint(subs[0].endpoint)) {
        await mark(row, "skipped");
        return "skipped";
      }
      // Never notify about a decision already handled or stale offer.
      const alerts = await select("big_money_alerts", {
        select: "id,status,created_at",
        id: "eq." + row.alert_id,
        user_id: "eq." + row.user_id,
        status: "eq.pending",
        limit: 1,
      });
      if (!alerts.length || now() - new Date(alerts[0].created_at).getTime() > ALERT_MAX_AGE_MS) {
        await mark(row, "skipped");
        return "skipped";
      }
      status = await send(subs[0].endpoint, config);
      if (status >= 200 && status < 300) {
        await mark(row, "delivered");
        return "delivered";
      }
      if (status === 404 || status === 410) {
        // Deleting the expired subscription cascades its undeliverable jobs.
        await remove("push_subscriptions", {
          id: "eq." + row.subscription_id,
          user_id: "eq." + row.user_id,
        });
        return "expired";
      }
      throw Object.assign(new Error("Push provider returned HTTP " + status), { httpStatus: status });
    } catch (error) {
      const patch = nextPushDeliveryState(
        row.attempt_count, error.message, error.httpStatus || status, now(), random
      );
      await updateClaimed(row, patch);
      logger.warn("[push-outbox] delivery failed", {
        deliveryId: row.id,
        attempt: row.attempt_count,
        nextStatus: patch.status,
        httpStatus: error.httpStatus || status,
      });
      return patch.status;
    }
  };

  const processOnce = async () => {
    if (busy || !pushConfigured(config)) return [];
    busy = true;
    try {
      const rows = await claim({ p_worker_id: workerId, p_batch_size: 10, p_lease_seconds: 30 });
      if (!Array.isArray(rows) || !rows.length) return [];
      return Promise.allSettled(rows.map(deliver));
    } catch (error) {
      logger.warn("[push-outbox] scanning failed:", error?.message || error);
      return [];
    } finally {
      busy = false;
    }
  };

  const start = () => {
    if (!pushConfigured(config)) {
      logger.info("[push-outbox] disabled: VAPID keys are not configured");
      return () => {};
    }
    void processOnce();
    const timer = setInterval(() => { void processOnce(); }, POLL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  };

  return { processOnce, start, workerId };
}

export function startPushDeliveryWorker() {
  return createPushDeliveryWorker().start();
}
