import express from "express";

import { repository } from "./repository.js";
import { isSupabaseConfigured } from "./supabase.js";

const subscribers = new Map();
let sequence = 0;

function normalizeScopes(scopes) {
  const values = Array.isArray(scopes) ? scopes : [scopes];
  const normalized = [
    ...new Set(
      values
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    ),
  ];
  return normalized.length ? normalized : ["all"];
}

export function subscribeUserChanges(userId, listener) {
  const key = String(userId || "");
  if (!key || typeof listener !== "function") return () => {};

  let listeners = subscribers.get(key);
  if (!listeners) {
    listeners = new Set();
    subscribers.set(key, listeners);
  }
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
    if (!listeners.size) subscribers.delete(key);
  };
}

export function publishUserChange(
  userId,
  scopes = ["all"],
  reason = "data_changed"
) {
  const key = String(userId || "");
  const listeners = subscribers.get(key);
  if (!key || !listeners?.size) return null;

  const event = {
    id: ++sequence,
    type: "invalidate",
    scopes: normalizeScopes(scopes),
    reason: String(reason || "data_changed"),
    at: new Date().toISOString(),
  };

  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // One dead client must not break delivery to other clients.
    }
  }

  return event;
}

export function scopesForUserWrite(path = "") {
  const value = String(path || "");

  if (value.includes("/activity")) return ["activity"];
  if (value.includes("/jobs")) return ["jobs", "activity"];
  if (value.includes("/assist-preferences")) return ["assist"];
  if (value.includes("/ridepicker")) return ["ridepicker", "activity"];
  if (value.includes("/billing")) return ["billing"];
  if (value.includes("/profile")) return ["profile"];
  if (value.includes("/preferences")) return ["preferences"];
  if (value.includes("/whatsapp")) {
    return ["whatsapp", "activity", "ridepicker"];
  }
  if (value.includes("/messages")) return ["messages", "activity"];

  return ["all"];
}

export function publishSuccessfulUserWrite(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  const userId = req.params?.userId || null;
  const scopes = scopesForUserWrite(req.originalUrl || req.url || "");

  res.once("finish", () => {
    if (userId && res.statusCode >= 200 && res.statusCode < 300) {
      publishUserChange(userId, scopes, "api_write");
    }
  });

  next();
}

const router = express.Router();

router.get("/api/users/:userId/events", async (req, res) => {
  if (!isSupabaseConfigured()) {
    return res.status(503).json({ error: "Supabase is not configured" });
  }

  try {
    const user = await repository.getUserById(req.params.userId);
    if (!user) return res.status(404).json({ error: "user not found" });
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error.message || "Could not open live data stream",
    });
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const writeEvent = (eventName, payload, id = null) => {
    if (id !== null) res.write(`id: ${id}\n`);
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  writeEvent("ready", { at: new Date().toISOString() });

  const unsubscribe = subscribeUserChanges(req.params.userId, (event) => {
    writeEvent("change", event, event.id);
  });

  // SSE comments keep intermediaries from closing an idle push connection.
  // They never trigger a data refetch and are not application polling.
  const keepAlive = setInterval(() => {
    res.write(`: keep-alive ${Date.now()}\n\n`);
  }, 25_000);
  keepAlive.unref?.();

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(keepAlive);
    unsubscribe();
  };

  req.once("close", cleanup);
  res.once("close", cleanup);
});

export default router;
