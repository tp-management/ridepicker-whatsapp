import express from "express";

import { repository } from "./repository.js";
import { deleteRows, insertRows, selectRows } from "./supabase.js";
import { isSupabaseConfigured } from "./supabase.js";
import { userApiRepository } from "./userApiRepository.js";

const router = express.Router();
const MAX_ACTIVITY_LIMIT = 500;

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  return res.status(status).json({
    error: error.message || "Unexpected error",
    ...(error.details ? { details: error.details } : {}),
  });
}

function requireSupabase(req, res, next) {
  if (!isSupabaseConfigured()) {
    return res.status(503).json({ error: "Supabase is not configured" });
  }
  next();
}

async function requireUser(req, res, next) {
  try {
    const user = await repository.getUserById(req.params.userId);
    if (!user) return res.status(404).json({ error: "user not found" });
    req.ridePickerUser = user;
    next();
  } catch (error) {
    sendError(res, error);
  }
}

const userRoute = [requireSupabase, requireUser];

function boundedLimit(value, fallback = 200) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_ACTIVITY_LIMIT);
}

function booleanQuery(value, fallback = true) {
  if (value === undefined) return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  const error = new Error("boolean query parameter must be true or false");
  error.status = 400;
  throw error;
}

export function classifyActivityKey(value) {
  const key = String(value || "").trim();
  const messageMatch = /^message:(\d+)$/.exec(key);
  if (messageMatch) {
    return { type: "message", key, id: messageMatch[1] };
  }

  const activityMatch = /^(?:activity:)?(\d+)$/.exec(key);
  if (activityMatch) {
    return { type: "activity", key, id: activityMatch[1] };
  }

  const error = new Error("invalid activity id");
  error.status = 400;
  throw error;
}

router.get("/api/users/:userId/activity", ...userRoute, async (req, res) => {
  try {
    const userId = req.params.userId;
    const limit = boundedLimit(req.query.limit);
    const includeMessages = booleanQuery(req.query.includeMessages, true);

    // Pull the largest supported window before applying tombstones so deleted
    // synthetic entries do not leave visible holes in a normal 200-row page.
    const candidates = await userApiRepository.listActivity(userId, {
      limit: MAX_ACTIVITY_LIMIT,
      includeMessages,
    });

    const dismissedRows = await selectRows("activity_dismissals", {
      select: "activity_key",
      user_id: `eq.${userId}`,
      limit: 2000,
    });
    const dismissed = new Set(dismissedRows.map((row) => String(row.activity_key)));
    const activity = candidates
      .filter((entry) => !dismissed.has(String(entry.id)))
      .slice(0, limit);

    res.setHeader("Cache-Control", "no-store");
    res.json({ activity });
  } catch (error) {
    sendError(res, error);
  }
});

router.delete(
  "/api/users/:userId/activity/:activityId",
  ...userRoute,
  async (req, res) => {
    try {
      const userId = req.params.userId;
      const target = classifyActivityKey(req.params.activityId);

      if (target.type === "activity") {
        const deleted = await deleteRows("activity", {
          id: `eq.${target.id}`,
          user_id: `eq.${userId}`,
        });
        if (!deleted.length) {
          return res.status(404).json({ error: "activity not found" });
        }
        return res.json({ ok: true, deleted: target.key, sourcePreserved: false });
      }

      // Message timeline entries are synthetic. Hide the activity entry but
      // preserve the underlying WhatsApp message and any job/context links.
      const session = await repository.getWhatsappSessionByUser(userId);
      if (!session) {
        return res.status(404).json({ error: "activity not found" });
      }

      const messages = await selectRows("messages", {
        select: "id",
        id: `eq.${target.id}`,
        session_id: `eq.${session.id}`,
        limit: 1,
      });
      if (!messages.length) {
        return res.status(404).json({ error: "activity not found" });
      }

      await insertRows(
        "activity_dismissals",
        [{ user_id: userId, activity_key: target.key }],
        {
          query: { on_conflict: "user_id,activity_key" },
          prefer: "resolution=ignore-duplicates,return=representation",
        }
      );

      return res.json({ ok: true, deleted: target.key, sourcePreserved: true });
    } catch (error) {
      sendError(res, error);
    }
  }
);

export default router;
