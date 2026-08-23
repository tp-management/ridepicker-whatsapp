import express from "express";

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

export default router;
