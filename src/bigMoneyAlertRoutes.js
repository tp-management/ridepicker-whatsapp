import express from "express";
import { repository } from "./repository.js";
import { isSupabaseConfigured, selectRows, updateRows, insertRows, callRpc } from "./supabase.js";
import { INTERNAL_API_KEY, BIG_MONEY_INGEST_KEY } from "./config.js";
import { publishUserChange } from "./liveEvents.js";
import { sendBigMoneyPush } from "./webPush.js";
import { processBigMoneyPushActions } from "./bigMoneyPushWorker.js";

const numericId = (value) => /^[1-9]\d*$/.test(String(value ?? ""));

const uuidId = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? ""));

export function bigMoneyDecisionStatus(value) {
  if (value === "accept") return "accepted";
  if (value === "decline") return "declined";
  return null;
}

export function bigMoneyAlertToApi(row) {
  return {
    id: String(row.id),
    messageId: row.source_message_id == null ? null : String(row.source_message_id),
    originalMessage: row.original_message,
    createdAt: row.created_at,
  };
}

// Injectable dependencies make HTTP tests independent of live Supabase and WhatsApp.
export function createBigMoneyAlertRouter({
  configured = isSupabaseConfigured,
  findUser = (id) => repository.getUserById(id),
  select = selectRows,
  update = updateRows,
  insert = insertRows,
  publish = publishUserChange,
  notify = sendBigMoneyPush,
  claim = (args) => callRpc("claim_big_money_push_actions", args),
  // Prefer an isolated BIG MONEY key; preserve existing deployments using INTERNAL_API_KEY.
  internalKey = BIG_MONEY_INGEST_KEY || INTERNAL_API_KEY,
  webhookSecret = process.env.BIG_MONEY_WEBHOOK_SECRET || "",
} = {}) {
  const router = express.Router();

  function fail(res, error) {
    const upstream = Number(error?.status || 500);
    const status = upstream >= 400 && upstream <= 599 ? upstream : 500;
    if (status >= 500) console.error("BIG MONEY API error:", error);
    res.status(status).json({
      error: status >= 500 ? "Could not process BIG MONEY alert" : error?.message || "Request failed",
    });
  }

  async function requireUser(req, res, next) {
    try {
      if (!configured()) return res.status(503).json({ error: "Supabase is not configured" });
      // Existing prototype user check; JWT ownership is a separate future task.
      const user = await findUser(req.params.userId);
      if (!user) return res.status(404).json({ error: "user not found" });
      next();
    } catch (error) { fail(res, error); }
  }

  router.get("/api/users/:userId/big-money-alerts", requireUser, async (req, res) => {
    try {
      const rows = await select("big_money_alerts", {
        select: "id,source_message_id,original_message,created_at",
        user_id: "eq." + req.params.userId,
        status: "eq.pending",
        order: "created_at.asc",
        limit: 100,
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ alerts: rows.map(bigMoneyAlertToApi) });
    } catch (error) { fail(res, error); }
  });

  router.patch("/api/users/:userId/big-money-alerts/:alertId", requireUser, async (req, res) => {
    try {
      const status = bigMoneyDecisionStatus(req.body?.decision);
      if (!status) return res.status(400).json({ error: "decision must be accept or decline" });
      if (!numericId(req.params.alertId)) return res.status(400).json({ error: "invalid alert id" });

      // Atomic compare-and-set: only pending rows of this user are modified.
      const rows = await update("big_money_alerts",
        { status, decided_at: new Date().toISOString() },
        {
          id: "eq." + req.params.alertId,
          user_id: "eq." + req.params.userId,
          status: "eq.pending",
        }
      );
      if (!rows.length) return res.status(409).json({ error: "alert already handled or unavailable" });
      // ACCEPT is a stored decision only. No reply, booking, or action X.
      res.json({ alert: { id: String(rows[0].id), status } });
    } catch (error) { fail(res, error); }
  });

  function requireInternal(req, res, next) {
    const key = req.get("x-api-key") || req.get("x-ridepicker-key");
    if (!internalKey || !key || key !== internalKey) {
      return res.status(401).json({ error: "internal authorization required" });
    }
    next();
  }

  // The database INSERT is the Push trigger, independent of n8n.
  router.post("/internal/big-money-inserted", async (req, res) => {
    const secret = req.get("x-ridepicker-webhook-key");
    if (!webhookSecret || !secret || secret !== webhookSecret) {
      return res.status(401).json({ error: "webhook authorization required" });
    }

    const payload = req.body;
    const record = payload?.record;
    if (payload?.type !== "INSERT" || payload?.schema !== "public"
      || payload?.table !== "big_money_alerts"
      || !numericId(record?.id) || !uuidId(record?.user_id)) {
      return res.status(400).json({ error: "invalid BIG MONEY webhook" });
    }

    try {
      // Verify the committed DB row. Never trust webhook-supplied job text.
      const rows = await select("big_money_alerts", {
        select: "id,user_id,status",
        id: "eq." + record.id,
        user_id: "eq." + record.user_id,
        limit: 1,
      });
      if (!rows.length || rows[0].status !== "pending") {
        return res.json({ ok: true, ignored: true });
      }

      const result = await processBigMoneyPushActions({
        alertId: rows[0].id,
        claim,
        notify,
        publish,
      });
      return res.json(result.claimed ? { ok: true } : { ok: true, ignored: true });
    } catch (error) { return fail(res, error); }
  });

  router.post("/internal/big-money-alerts", requireInternal, async (req, res) => {
    try {
      if (!configured()) return res.status(503).json({ error: "Supabase is not configured" });
      const userId = String(req.body?.userId || "");
      const messageId = String(req.body?.messageId || "");
      if (!userId || !numericId(messageId)) {
        return res.status(400).json({ error: "userId and numeric messageId are required" });
      }

      // Snapshot the original DB message, never text supplied by the caller.
      // A user can have historical/relinked WhatsApp sessions. Look up the
      // specific message, then verify ownership of its actual session instead
      // of assuming the user's first session owns every message.
      const source = await select("messages", {
        select: "id,body,session_id", id: "eq." + messageId, limit: 1,
      });
      if (!source.length || typeof source[0].body !== "string" || !source[0].body.trim()) {
        return res.status(404).json({ error: "Original WhatsApp text not found" });
      }
      const ownedSession = await select("whatsapp_sessions", {
        select: "id",
        id: "eq." + source[0].session_id,
        user_id: "eq." + userId,
        limit: 1,
      });
      if (!ownedSession.length) {
        return res.status(404).json({ error: "Original WhatsApp text not found" });
      }

      const rows = await insert("big_money_alerts", [{
        user_id: userId, source_message_id: source[0].id, original_message: source[0].body,
      }], {
        query: { on_conflict: "user_id,source_message_id" },
        prefer: "resolution=ignore-duplicates,return=representation",
      });
      // No replay/notification for duplicate or previously processed alert.
      if (rows.length) {
        publish(userId, ["big_money_alerts"], "big_money_alert_received");
        // The Supabase INSERT webhook handles Push for every new row.
      }
      res.status(rows.length ? 201 : 200).json({ ok: true, created: rows.length > 0 });
    } catch (error) { fail(res, error); }
  });

  return router;
}

export default createBigMoneyAlertRouter();
