import express from "express";

import { repository } from "./repository.js";
import { deleteRows, insertRows, selectRows } from "./supabase.js";
import { isSupabaseConfigured } from "./supabase.js";
import { userApiRepository } from "./userApiRepository.js";

const router = express.Router();
const MAX_ACTIVITY_LIMIT = 500;
const ACTIVITY_PRIORITIES = new Set(["regular", "high"]);

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

export function canonicalActivityKey(value) {
  const target = classifyActivityKey(value);
  return target.type === "message"
    ? `message:${target.id}`
    : `activity:${target.id}`;
}

export function normalizeActivityPriority(value) {
  const priority = String(value || "").trim().toLowerCase();
  if (!ACTIVITY_PRIORITIES.has(priority)) {
    const error = new Error("priority must be regular or high");
    error.status = 400;
    throw error;
  }
  return priority;
}

// Remove per-user overrides when an item leaves the Activity timeline.
async function deleteActivityPriority(userId, activityKey) {
  await deleteRows("activity_priorities", {
    user_id: `eq.${userId}`,
    activity_key: `eq.${canonicalActivityKey(activityKey)}`,
  });
}

async function activityTargetExists(userId, target) {
  if (target.type === "activity") {
    const rows = await selectRows("activity", {
      select: "id",
      id: `eq.${target.id}`,
      user_id: `eq.${userId}`,
      limit: 1,
    });
    return rows.length > 0;
  }

  const session = await repository.getWhatsappSessionByUser(userId);
  if (!session) return false;

  const rows = await selectRows("messages", {
    select: "id",
    id: `eq.${target.id}`,
    session_id: `eq.${session.id}`,
    limit: 1,
  });
  return rows.length > 0;
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

    const [dismissedRows, priorityRows] = await Promise.all([
      selectRows("activity_dismissals", {
        select: "activity_key",
        user_id: `eq.${userId}`,
        limit: 2000,
      }),
      selectRows("activity_priorities", {
        select: "activity_key,priority",
        user_id: `eq.${userId}`,
        limit: 2000,
      }),
    ]);

    const dismissed = new Set(dismissedRows.map((row) => String(row.activity_key)));
    const priorities = new Map(
      priorityRows.map((row) => [
        String(row.activity_key),
        ACTIVITY_PRIORITIES.has(row.priority) ? row.priority : "regular",
      ])
    );
    const activity = candidates
      .filter((entry) => !dismissed.has(String(entry.id)))
      .map((entry) => ({
        ...entry,
        priority: priorities.get(canonicalActivityKey(entry.id)) || "regular",
      }))
      .slice(0, limit);

    res.setHeader("Cache-Control", "no-store");
    res.json({ activity });
  } catch (error) {
    sendError(res, error);
  }
});

router.patch(
  "/api/users/:userId/activity/:activityId",
  ...userRoute,
  async (req, res) => {
    try {
      const userId = req.params.userId;
      const target = classifyActivityKey(req.params.activityId);
      const priority = normalizeActivityPriority(req.body?.priority);

      if (!(await activityTargetExists(userId, target))) {
        return res.status(404).json({ error: "activity not found" });
      }

      const activityKey = canonicalActivityKey(target.key);
      // Regular is the default: remove the override instead of storing noise.
      if (priority === "regular") {
        await deleteActivityPriority(userId, activityKey);
        return res.json({ activityId: target.key, priority });
      }

      const rows = await insertRows(
        "activity_priorities",
        [
          {
            user_id: userId,
            activity_key: activityKey,
            priority,
            updated_at: new Date().toISOString(),
          },
        ],
        {
          query: { on_conflict: "user_id,activity_key" },
          prefer: "resolution=merge-duplicates,return=representation",
        }
      );

      return res.json({
        activityId: target.key,
        priority: rows?.[0]?.priority || priority,
      });
    } catch (error) {
      sendError(res, error);
    }
  }
);

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
        await deleteActivityPriority(userId, target.key);
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

      await deleteActivityPriority(userId, target.key);
      return res.json({ ok: true, deleted: target.key, sourcePreserved: true });
    } catch (error) {
      sendError(res, error);
    }
  }
);

export default router;
