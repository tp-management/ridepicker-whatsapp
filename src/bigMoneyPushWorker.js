import { callRpc } from "./supabase.js";
import { sendBigMoneyPush } from "./webPush.js";
import { publishUserChange } from "./liveEvents.js";

export const BIG_MONEY_POLL_MS = 2_000;
export const BIG_MONEY_MAX_PUSHES = 10;
export const BIG_MONEY_PUSH_INTERVAL_MS = 30_000;

// The database owns the schedule, attempt count, and transition to ignored.
// Both the insert webhook and the worker use this exact atomic claim.
export async function processBigMoneyPushActions({
  alertId = null,
  claim = (args) => callRpc("claim_big_money_push_actions", args),
  notify = sendBigMoneyPush,
  publish = publishUserChange,
  logger = console,
} = {}) {
  const actions = await claim({
    p_batch_size: alertId == null ? 25 : 1,
    p_alert_id: alertId == null ? null : Number(alertId),
  });
  if (!Array.isArray(actions) || actions.length === 0) return { claimed: 0 };

  await Promise.allSettled(actions.map(async (item) => {
    if (item.action === "ignored") {
      publish(item.user_id, ["big_money_alerts"], "big_money_alert_ignored");
      logger.info("[big-money-push] Auto-ignored after 10 notifications", { alertId: item.alert_id });
      return;
    }
    if (item.action !== "send") {
      logger.warn("[big-money-push] Unknown claim action", { action: item.action });
      return;
    }
    if (Number(item.attempt_number) === 1) {
      publish(item.user_id, ["big_money_alerts"], "big_money_alert_received");
    }
    try {
      const result = await notify(item.user_id);
      logger.info("[big-money-push] Attempt completed", {
        alertId: item.alert_id,
        attempt: item.attempt_number,
        deliveredToServices: result?.sent ?? null,
      });
    } catch (error) {
      // Failed sends still count toward the 10-attempt limit; never loop forever.
      logger.warn("[big-money-push] Delivery unavailable:", error?.message || error);
    }
  }));

  return { claimed: actions.length };
}

export function createBigMoneyPushWorker({
  process = processBigMoneyPushActions,
  logger = console,
  intervalMs = BIG_MONEY_POLL_MS,
} = {}) {
  let busy = false;
  async function processOnce() {
    if (busy) return { claimed: 0 };
    busy = true;
    try {
      return await process();
    } catch (error) {
      logger.error("[big-money-push] Reminder scan failed:", error?.message || error);
      return { claimed: 0, error: true };
    } finally {
      busy = false;
    }
  }
  function start() {
    void processOnce();
    const timer = setInterval(() => { void processOnce(); }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
  return { processOnce, start };
}

export function startBigMoneyPushWorker() {
  return createBigMoneyPushWorker().start();
}
