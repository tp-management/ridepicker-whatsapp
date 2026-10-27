import express from "express";
import { repository } from "./repository.js";
import { isSupabaseConfigured, selectRows, updateRows, insertRows } from "./supabase.js";
import { INTERNAL_API_KEY } from "./config.js";
import { publishUserChange } from "./liveEvents.js";

const router = express.Router();

function fail(res, error) {
  const status = Number(error?.status || 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? "Could not process BIG MONEY alert" : error.message });
}

async function requireUser(req, res, next) {
  try {
    if (!isSupabaseConfigured()) return res.status(503).json({ error: "Supabase is not configured" });
    // Existing prototype ownership boundary. Must be replaced with verified
    // Supabase JWT ownership before public rollout.
    const user = await repository.getUserById(req.params.userId);
    if (!user) return res.status(404).json({ error: "user not found" });
    next();
  } catch (error) { fail(res, error); }
}

router.get("/api/users/:userId/big-money-alerts", requireUser, async (req, res) => {
  try {
    const rows = await selectRows("big_money_alerts", {
      select: "id,source_message_id,original_message,created_at",
      user_id: `eq.${req.params.userId}`,
      status: "eq.pending",
      order: "created_at.asc",
      limit: 100,
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ alerts: rows.map((row) => ({
      id: String(row.id),
      messageId: row.source_message_id === null ? null : String(row.source_message_id),
      originalMessage: row.original_message,
      createdAt: row.created_at,
    })) });
  } catch (error) { fail(res, error); }
});

router.patch("/api/users/:userId/big-money-alerts/:alertId", requireUser, async (req, res) => {
  try {
    const decision = req.body?.decision;
    if (!["accept", "decline"].includes(decision)) {
      return res.status(400).json({ error: "decision must be accept or decline" });
    }
    if (!/^\d+$/.test(String(req.params.alertId))) {
      return res.status(400).json({ error: "invalid alert id" });
    }
    const status = decision === "accept" ? "accepted" : "declined";
    const rows = await updateRows("big_money_alerts",
      { status, decided_at: new Date().toISOString() },
      { id: `eq.${req.params.alertId}`, user_id: `eq.${req.params.userId}`, status: "eq.pending" }
    );
    if (!rows.length) return res.status(409).json({ error: "alert already handled or unavailable" });
    // X (future accept action) intentionally not implemented.
    res.json({ alert: { id: String(rows[0].id), status } });
  } catch (error) { fail(res, error); }
});


function requireInternal(req, res, next) {
  const key = req.get("x-api-key") || req.get("x-ridepicker-key");
  if (!INTERNAL_API_KEY || !key || key !== INTERNAL_API_KEY) {
    return res.status(401).json({ error: "internal authorization required" });
  }
  next();
}

// Future n8n detector writes a new alert by referencing an existing stored
// WhatsApp message. Never accept fabricated message text from the caller.
router.post("/internal/big-money-alerts", requireInternal, async (req, res) => {
  try {
    if (!isSupabaseConfigured()) return res.status(503).json({ error: "Supabase is not configured" });
    const userId = String(req.body?.userId || "");
    const messageId = String(req.body?.messageId || "");
    if (!userId || !/^\d+$/.test(messageId)) {
      return res.status(400).json({ error: "userId and numeric messageId are required" });
    }
    const sessions = await selectRows("whatsapp_sessions", { select: "id", user_id: `eq.${userId}`, limit: 1 });
    if (!sessions.length) return res.status(404).json({ error: "WhatsApp session not found" });
    const source = await selectRows("messages", {
      select: "id,body",
      id: `eq.${messageId}`,
      session_id: `eq.${sessions[0].id}`,
      limit: 1,
    });
    if (!source.length || !String(source[0].body || "").trim()) {
      return res.status(404).json({ error: "Original WhatsApp text not found" });
    }
    const rows = await insertRows("big_money_alerts", [{
      user_id: userId, source_message_id: source[0].id,
      original_message: source[0].body,
    }], {
      query: { on_conflict: "user_id,source_message_id" },
      prefer: "resolution=ignore-duplicates,return=representation",
    });
    publishUserChange(userId, ["big_money_alerts"], "big_money_alert_received");
    return res.status(rows.length ? 201 : 200).json({ ok: true });
  } catch (error) { fail(res, error); }
});

export default router;
