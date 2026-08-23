import express from "express";

import { repository } from "./repository.js";
import { isSupabaseConfigured } from "./supabase.js";

const subscribers = new Map();
const pending = new Map();
const sessionOwners = new Map();
let sequence = 0;
let repositoryHooksInstalled = false;

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

function cacheSessionOwner(row) {
  if (row?.id && row?.user_id) {
    sessionOwners.set(String(row.id), String(row.user_id));
  }
  return row;
}

function deliverPending(userId) {
  const key = String(userId || "");
  const queued = pending.get(key);
  if (!queued) return null;
  pending.delete(key);

  const listeners = subscribers.get(key);
  if (!listeners?.size) return null;

  const event = {
    id: ++sequence,
    type: "invalidate",
    scopes: [...queued.scopes],
    reason:
      queued.reasons.size === 1
        ? [...queued.reasons][0]
        : "batched_change",
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
  if (!key) return false;

  let queued = pending.get(key);
  if (!queued) {
    queued = {
      scopes: new Set(),
      reasons: new Set(),
      timer: null,
    };
    pending.set(key, queued);
  }

  for (const scope of normalizeScopes(scopes)) queued.scopes.add(scope);
  queued.reasons.add(String(reason || "data_changed"));

  if (!queued.timer) {
    queued.timer = setTimeout(() => deliverPending(key), 30);
    queued.timer.unref?.();
  }

  return true;
}

export function installRepositoryLiveEvents() {
  if (repositoryHooksInstalled) return;
  repositoryHooksInstalled = true;

  const originalGetByUser = repository.getWhatsappSessionByUser.bind(repository);
  repository.getWhatsappSessionByUser = async (...args) =>
    cacheSessionOwner(await originalGetByUser(...args));

  const originalGetById = repository.getWhatsappSessionById.bind(repository);
  repository.getWhatsappSessionById = async (...args) =>
    cacheSessionOwner(await originalGetById(...args));

  const originalListSessions = repository.listWhatsappSessions.bind(repository);
  repository.listWhatsappSessions = async (...args) => {
    const rows = await originalListSessions(...args);
    for (const row of rows || []) cacheSessionOwner(row);
    return rows;
  };

  const originalEnsureSession = repository.ensureWhatsappSession.bind(repository);
  repository.ensureWhatsappSession = async (...args) =>
    cacheSessionOwner(await originalEnsureSession(...args));

  const originalUpdateById = repository.updateWhatsappSessionById.bind(repository);
  repository.updateWhatsappSessionById = async (sessionId, patch, ...rest) => {
    const row = cacheSessionOwner(
      await originalUpdateById(sessionId, patch, ...rest)
    );
    const userId = row?.user_id || sessionOwners.get(String(sessionId));
    if (userId) {
      const scopes = ["whatsapp"];
      if (patch?.bot_mode !== undefined || patch?.bot_enabled_at !== undefined) {
        scopes.push("ridepicker");
      }
      publishUserChange(userId, scopes, "whatsapp_state");
    }
    return row;
  };

  const originalUpdateByUser = repository.updateWhatsappSessionByUser.bind(repository);
  repository.updateWhatsappSessionByUser = async (userId, patch, ...rest) => {
    const row = cacheSessionOwner(
      await originalUpdateByUser(userId, patch, ...rest)
    );
    const scopes = ["whatsapp"];
    if (patch?.bot_mode !== undefined || patch?.bot_enabled_at !== undefined) {
      scopes.push("ridepicker");
    }
    publishUserChange(userId, scopes, "whatsapp_state");
    return row;
  };

  const originalAddActivity = repository.addActivity.bind(repository);
  repository.addActivity = async (userId, entry, ...rest) => {
    const result = await originalAddActivity(userId, entry, ...rest);
    publishUserChange(userId, ["activity"], "activity_write");
    return result;
  };

  const originalInsertMessage = repository.insertMessage.bind(repository);
  repository.insertMessage = async (input, ...rest) => {
    const result = await originalInsertMessage(input, ...rest);
    if (!result) return result;

    const sessionId = input?.session_id;
    let userId = sessionOwners.get(String(sessionId || ""));
    if (!userId && sessionId) {
      const row = await repository.getWhatsappSessionById(sessionId);
      userId = row?.user_id || null;
    }
    if (userId) {
      publishUserChange(userId, ["messages", "activity"], "message_write");
    }
    return result;
  };
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
