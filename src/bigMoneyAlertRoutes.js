import express from "express";
import { repository } from "./repository.js";
import { isSupabaseConfigured, selectRows, updateRows } from "./supabase.js";

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
    if (!/^\\d+$/.test(String(req.params.alertId))) {
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

export default router;
