import express from "express";

import { sanitizeAssistKeywords } from "./assistPreferences.js";
import { repository } from "./repository.js";
import { insertRows, isSupabaseConfigured } from "./supabase.js";

const router = express.Router();

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
    return res.status(503).json({
      error:
        "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the backend.",
    });
  }
  next();
}

async function requireUser(req, res, next) {
  try {
    const user = await repository.getUserById(req.params.userId);
    if (!user) {
      return res.status(404).json({ error: "user not found" });
    }
    req.ridePickerUser = user;
    next();
  } catch (error) {
    sendError(res, error);
  }
}

function toApi(row) {
  return {
    keywords: Array.isArray(row?.assist_keywords) ? row.assist_keywords : [],
  };
}

async function ensureDriverPreferences(userId) {
  const existing = await repository.getDriverPreferences(userId);
  if (existing) return existing;

  // Older RidePicker users can pre-date driver_preferences. Create the default
  // row lazily and make the insert race-safe so concurrent GET/PUT requests do
  // not turn a harmless missing row into a 404 or unique-key failure.
  const created = await insertRows(
    "driver_preferences",
    [{ user_id: userId }],
    {
      query: { on_conflict: "user_id" },
      prefer: "resolution=ignore-duplicates,return=representation",
    }
  );

  return created?.[0] || repository.getDriverPreferences(userId);
}

const userRoute = [requireSupabase, requireUser];

router.get(
  "/api/users/:userId/assist-preferences",
  ...userRoute,
  async (req, res) => {
    try {
      const row = await ensureDriverPreferences(req.params.userId);
      if (!row) {
        throw new Error("Could not initialize driver preferences");
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({ assistPreferences: toApi(row) });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.put(
  "/api/users/:userId/assist-preferences",
  ...userRoute,
  async (req, res) => {
    try {
      const session = await repository.getWhatsappSessionByUser(req.params.userId);
      if (!session || session.status !== "CONNECTED") {
        return res.status(409).json({
          error: "Connect WhatsApp before changing Assist preferences",
        });
      }

      await ensureDriverPreferences(req.params.userId);

      const keywords = sanitizeAssistKeywords(req.body?.keywords);
      const row = await repository.updateDriverPreferences(req.params.userId, {
        assist_keywords: keywords,
      });

      if (!row) {
        throw new Error("Could not update driver preferences");
      }

      res.json({ assistPreferences: toApi(row) });
    } catch (error) {
      sendError(res, error);
    }
  }
);

export default router;
