import express from "express";

import { INTERNAL_API_KEY } from "../config.js";
import { repository } from "../repository.js";
import { isSupabaseConfigured } from "../supabase.js";
import { disconnectSession, getSession } from "../whatsapp.js";
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

function requireInternalKey(req, res, next) {
  if (!INTERNAL_API_KEY) {
    return res.status(503).json({
      error: "INTERNAL_API_KEY is not configured",
    });
  }

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

// The legacy delete endpoint is destructive and must never be public. For a
// durable RidePicker session it delegates to the same guarded remote-unlink
// workflow as the frontend. A truly legacy runtime session is allowed only
// with the internal key: registered runtimes require native remote logout;
// unregistered runtimes are safe to remove locally. Missing runtimes fail
// closed so persisted credentials are never erased blindly.
router.delete(
  "/sessions/:id",
  requireInternalKey,
  requireSupabase,
  async (req, res) => {
    try {
      const dbSession = await repository.getWhatsappSessionById(req.params.id);

      if (dbSession?.user_id) {
        await disconnectManagedSessionSafely(dbSession.user_id);
        return res.json({ ok: true });
      }

      const runtime = getSession(req.params.id);
      if (!runtime) {
        return res.status(404).json({
          error: "session not found; no credentials were removed",
        });
      }

      const linkedRuntime = Boolean(
        runtime.registered || runtime.socket?.user?.id
      );

      await disconnectSession(req.params.id, {
        requestRemoteLogout: linkedRuntime,
      });

      return res.json({ ok: true });
    } catch (error) {
      return sendError(res, error);
    }
  }
);

export default router;
