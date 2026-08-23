import express from "express";

import { INTERNAL_API_KEY } from "../config.js";
import { repository } from "../repository.js";
import { isSupabaseConfigured } from "../supabase.js";
import { disconnectManagedSessionSafely } from "./managedSessionBoundary.js";

const router = express.Router();

function sendError(res, error) {
  const status = error.status || 500;

  if (status >= 500) {
    console.error(error);
  }

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

function optionalInternalProtection(req, res, next) {
  if (!INTERNAL_API_KEY) return next();

  const key = req.get("x-api-key") || req.get("x-ridepicker-key");
  if (key !== INTERNAL_API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
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

// Mounted before the legacy/user router so user-requested disconnects always
// use the guarded remote-unlink workflow. The older route remains for source
// compatibility but is unreachable for this exact user-facing path.
router.delete(
  "/api/users/:userId/whatsapp",
  requireSupabase,
  requireUser,
  async (req, res) => {
    try {
      const session = await disconnectManagedSessionSafely(req.params.userId);
      res.setHeader("Cache-Control", "no-store");
      res.json({ session });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// The legacy /sessions/:id endpoint historically called disconnectSession()
// directly, which could clear established auth even when remote logout failed.
// Intercept durable user-owned sessions here and route them through the same
// guarded workflow. Truly legacy, non-durable runtime sessions fall through to
// the old handler so unrelated manual tooling keeps its existing behavior.
router.delete(
  "/sessions/:id",
  optionalInternalProtection,
  requireSupabase,
  async (req, res, next) => {
    try {
      const dbSession = await repository.getWhatsappSessionById(req.params.id);
      if (!dbSession?.user_id) return next();

      await disconnectManagedSessionSafely(dbSession.user_id);
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error);
    }
  }
);

export default router;
