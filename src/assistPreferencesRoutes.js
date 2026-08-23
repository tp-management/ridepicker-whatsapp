import express from "express";

import { sanitizeAssistKeywords } from "./assistPreferences.js";
import { repository } from "./repository.js";
import { isSupabaseConfigured } from "./supabase.js";

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

const userRoute = [requireSupabase, requireUser];

router.get(
  "/api/users/:userId/assist-preferences",
  ...userRoute,
  async (req, res) => {
    try {
      const row = await repository.getDriverPreferences(req.params.userId);
      if (!row) {
        return res.status(404).json({ error: "driver preferences not found" });
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

      const keywords = sanitizeAssistKeywords(req.body?.keywords);
      const row = await repository.updateDriverPreferences(req.params.userId, {
        assist_keywords: keywords,
      });

      if (!row) {
        return res.status(404).json({ error: "driver preferences not found" });
      }

      res.json({ assistPreferences: toApi(row) });
    } catch (error) {
      sendError(res, error);
    }
  }
);

export default router;
