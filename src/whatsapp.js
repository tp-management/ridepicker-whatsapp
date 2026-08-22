import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import { Boom } from "@hapi/boom";

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

import {
  DATA_DIR,
  N8N_FORWARD_MEDIA_WITHOUT_TEXT,
  N8N_FORWARD_FROM_ME,
  N8N_FORWARD_SESSION_EVENTS,
  N8N_WEBHOOK_URL,
  RESTORE_LEGACY_SESSIONS,
  SESSION_POLICY_CACHE_MS,
} from "./config.js";
import { repository } from "./repository.js";
import { writeSystemLog } from "./systemLog.js";
import { isSupabaseConfigured } from "./supabase.js";
import {
  isoFromWhatsappTimestamp,
  phoneDigits,
  toFrontendWhatsappStatus,
} from "./utils.js";

fs.mkdirSync(DATA_DIR, {
  recursive: true,
});

const sessions = new Map();
const managedPairingFlows = new Map();
const groupNameCache = new Map();
const policyCache = new Map();
const chatWriteCache = new Map();

const GROUP_CACHE_TTL = 10 * 60 * 1000;
const CHAT_WRITE_TTL = 10 * 60 * 1000;

// WhatsApp Web's phone-number pairing UI refreshes its code roughly every
// three minutes. Baileys does not rotate pairing codes for us, so RidePicker
// owns that lifecycle for managed sessions.
const MANAGED_PAIRING_ROTATE_MS = 3 * 60 * 1000;

// Baileys can resolve requestPairingCode() before WhatsApp has finished
// validating the underlying companion_hello request. A short grace window
// prevents us from publishing codes that are rejected immediately afterwards.
const MANAGED_PAIRING_PUBLISH_GRACE_MS = 3 * 1000;

// Automatic recovery is deliberately bounded. Repeatedly hammering WhatsApp
// after 400/401/428/515 failures can make rate limiting or account-risk checks
// worse, so after three automatic retries we stop and require a new user tap.
const MANAGED_PAIRING_RETRY_DELAYS_MS = [3_000, 10_000, 30_000];
const MANAGED_PAIRING_MAX_AUTOMATIC_RETRIES =
  MANAGED_PAIRING_RETRY_DELAYS_MS.length;

// A 408 after a code has been alive for most of its normal three-minute cycle
// is treated as ordinary expiry rather than a protocol failure.
const MANAGED_PAIRING_NATURAL_EXPIRY_MIN_AGE_MS = 2 * 60 * 1000;

// Legacy/internal pairing-code endpoint compatibility only. Managed user
// pairing below does NOT use this value as proof that a code is still valid.
const LEGACY_PAIRING_CODE_DISPLAY_TTL = 3 * 60 * 1000;

const PAIRING_READY_TIMEOUT_MS = 15 * 1000;
const REGISTRATION_CONFIRM_TIMEOUT_MS = 5 * 1000;

const TRACKABLE_MESSAGE_TYPES = new Set([
  "text",
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "location",
  "contact",
]);

function logWhatsappEvent(
  session,
  level,
  event,
  message = null,
  details = {}
) {
  // Do not await persistent logging inside Baileys lifecycle handlers.
  // Logging must never slow down or break the WhatsApp handshake.
  void writeSystemLog({
    userId: session?.userId || null,
    sessionId: session?.userId ? session?.id || null : null,
    level,
    source: "whatsapp",
    event,
    message,
    details,
  });
}

function authPathFor(sessionId) {
  return path.join(DATA_DIR, sessionId);
}

function removeAuthDirectory(sessionId) {
  const authPath = authPathFor(sessionId);

  try {
    fs.rmSync(authPath, {
      recursive: true,
      force: true,
    });
  } catch (error) {
    console.warn(
      `[${sessionId}] could not remove auth directory:`,
      error.message
    );
  }
}

function socketAccount(socket) {
  const jid = socket?.user?.id || null;
  const rawUser = jid ? jid.split("@")[0].split(":")[0] : null;
  const phone = rawUser && /^\d+$/.test(rawUser) ? `+${rawUser}` : null;

  return {
    name: socket?.user?.name || null,
    phone,
  };
}

function clearReconnectTimer(session) {
  if (session?.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
}

function clearPolicyCache(sessionId) {
  policyCache.delete(sessionId);
}

function resolvePairingReady(session) {
  if (!session || session.pairingReady) {
    return;
  }

  session.pairingReady = true;

  for (const resolve of session.pairingReadyResolvers || []) {
    resolve();
  }

  session.pairingReadyResolvers = [];
}

function waitForPairingReady(session) {
  if (session?.pairingReady) {
    return Promise.resolve();
  }

  if (!session?.socket) {
    return Promise.reject(
      Object.assign(new Error("WhatsApp socket is not available"), {
        status: 409,
      })
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;

      session.pairingReadyResolvers = (
        session.pairingReadyResolvers || []
      ).filter((item) => item !== finish);

      reject(
        Object.assign(
          new Error(
            "WhatsApp connection was not ready for pairing. Generate a new code and try again."
          ),
          { status: 504 }
        )
      );
    }, PAIRING_READY_TIMEOUT_MS);

    session.pairingReadyResolvers ||= [];
    session.pairingReadyResolvers.push(finish);
  });
}

async function waitForRegisteredSession(session, socket) {
  const startedAt = Date.now();

  while (
    Date.now() - startedAt < REGISTRATION_CONFIRM_TIMEOUT_MS
  ) {
    if (session?.registered && socket?.user?.id) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return Boolean(session?.registered && socket?.user?.id);
}

function legacyPairingCodeIsFresh(session) {
  if (!session?.pairingCode || !session?.pairingCodeIssuedAt) {
    return false;
  }

  const issuedAt = new Date(session.pairingCodeIssuedAt).getTime();
  return (
    Number.isFinite(issuedAt) &&
    Date.now() - issuedAt < LEGACY_PAIRING_CODE_DISPLAY_TTL
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCurrentSession(session) {
  return Boolean(
    session &&
      !session.disposed &&
      sessions.get(session.id) === session
  );
}

function clearManagedPairingTimers(flow) {
  if (!flow) return;

  if (flow.rotateTimer) {
    clearTimeout(flow.rotateTimer);
    flow.rotateTimer = null;
  }

  if (flow.retryTimer) {
    clearTimeout(flow.retryTimer);
    flow.retryTimer = null;
  }
}

function invalidateManagedPairingCode(flow) {
  if (!flow) return;

  flow.code = null;
  flow.codeIssuedAt = null;
  flow.codeRotatesAt = null;
  flow.published = false;
}

function managedPairingCodeIsVisible(flow) {
  return Boolean(
    flow?.active &&
      flow?.published &&
      flow?.code &&
      flow?.codeIssuedAt
  );
}

function stopManagedPairingFlow(
  sessionId,
  { keepForError = false } = {}
) {
  const flow = managedPairingFlows.get(sessionId);
  if (!flow) return;

  clearManagedPairingTimers(flow);
  flow.active = false;
  flow.requestInFlight = false;
  flow.attemptToken += 1;
  invalidateManagedPairingCode(flow);

  if (!keepForError) {
    managedPairingFlows.delete(sessionId);
  }
}

function ensureManagedPairingFlow({ sessionId, userId, phone }) {
  const digits = phoneDigits(phone);

  if (!digits) {
    const error = new Error(
      'A valid WhatsApp phone number with country code is required.'
    );
    error.status = 400;
    throw error;
  }

  let flow = managedPairingFlows.get(sessionId);

  if (!flow) {
    flow = {
      sessionId,
      userId,
      phoneDigits: digits,
      phone: `+${digits}`,
      active: true,
      requestInFlight: false,
      attemptToken: 0,
      generation: 0,
      failureCount: 0,
      retryTimer: null,
      rotateTimer: null,
      code: null,
      codeIssuedAt: null,
      codeRotatesAt: null,
      published: false,
      lastError: null,
      lastFailureAt: null,
    };

    managedPairingFlows.set(sessionId, flow);
    return flow;
  }

  const phoneChanged = flow.phoneDigits !== digits;
  const restartingAfterTerminalError = !flow.active;

  if (phoneChanged || restartingAfterTerminalError) {
    clearManagedPairingTimers(flow);
    invalidateManagedPairingCode(flow);
    flow.requestInFlight = false;
    flow.attemptToken += 1;
    flow.failureCount = 0;
    flow.lastError = null;
    flow.lastFailureAt = null;
  }

  flow.userId = userId;
  flow.phoneDigits = digits;
  flow.phone = `+${digits}`;
  flow.active = true;

  return flow;
}

function dropSocketSession(
  session,
  { removeAuth = false, reason = 'Replacing WhatsApp socket' } = {}
) {
  if (!session) return;

  clearReconnectTimer(session);
  session.disposed = true;

  // Release any waiter that is blocked waiting for QR readiness. The waiter
  // re-checks isCurrentSession() immediately afterwards and exits safely.
  resolvePairingReady(session);

  const socket = session.socket;
  session.socket = null;

  if (sessions.get(session.id) === session) {
    sessions.delete(session.id);
  }

  if (socket) {
    try {
      socket.end?.(new Error(reason));
    } catch {
      // The transport may already be closed.
    }
  }

  if (removeAuth) {
    removeAuthDirectory(session.id);
  }
}

function managedPairingRetryDelay(failureCount) {
  const index = Math.max(
    0,
    Math.min(
      failureCount - 1,
      MANAGED_PAIRING_RETRY_DELAYS_MS.length - 1
    )
  );

  return MANAGED_PAIRING_RETRY_DELAYS_MS[index];
}

function scheduleManagedPairingRotation(flow) {
  if (!flow?.active || !flow.codeRotatesAt) return;

  if (flow.rotateTimer) {
    clearTimeout(flow.rotateTimer);
  }

  const delay = Math.max(
    1_000,
    new Date(flow.codeRotatesAt).getTime() - Date.now()
  );

  flow.rotateTimer = setTimeout(() => {
    flow.rotateTimer = null;

    if (!flow.active) return;

    // Surviving a full code cycle is a strong enough signal to reset the
    // abnormal-failure circuit breaker.
    flow.failureCount = 0;
    invalidateManagedPairingCode(flow);

    const session = sessions.get(flow.sessionId);
    if (isCurrentSession(session)) {
      session.status = 'STARTING';
      session.lastError = null;
      session.pairingCode = null;
      session.pairingCodeIssuedAt = null;
      session.pairingAttemptActive = true;

      void persistSessionState(session, {
        status: 'STARTING',
      });
    }

    void writeSystemLog({
      userId: flow.userId,
      sessionId: flow.sessionId,
      level: 'info',
      source: 'whatsapp',
      event: 'pairing_code_refresh_started',
      message: 'Refreshing WhatsApp pairing code automatically',
      details: {
        reason: 'scheduled_3_minute_refresh',
      },
    });

    void ensureManagedPairingAttempt(flow, {
      reason: 'scheduled_refresh',
      forceNewCode: true,
    });
  }, delay);
}

async function handleManagedPairingFailure(
  flow,
  session,
  {
    statusCode = null,
    message = 'WhatsApp pairing failed',
    phase = 'connection',
  } = {}
) {
  if (!flow?.active) return;

  const codeAgeMs = flow.codeIssuedAt
    ? Date.now() - new Date(flow.codeIssuedAt).getTime()
    : 0;

  const naturalExpiry =
    statusCode === DisconnectReason.timedOut &&
    codeAgeMs >= MANAGED_PAIRING_NATURAL_EXPIRY_MIN_AGE_MS;

  clearManagedPairingTimers(flow);
  flow.requestInFlight = false;
  flow.attemptToken += 1;
  flow.lastError = {
    code: statusCode,
    message,
  };
  flow.lastFailureAt = new Date().toISOString();
  invalidateManagedPairingCode(flow);

  if (naturalExpiry) {
    flow.failureCount = 0;
  } else {
    flow.failureCount += 1;
  }

  const canAutoRetry =
    naturalExpiry ||
    flow.failureCount <= MANAGED_PAIRING_MAX_AUTOMATIC_RETRIES;

  if (session) {
    session.pairingAttemptActive = false;
    session.pairingRequestInFlight = false;
    session.pairingCode = null;
    session.pairingCodeIssuedAt = null;
    session.pairingPhone = flow.phone;
    session.lastError = flow.lastError;
    session.status = canAutoRetry ? 'STARTING' : 'ERROR';

    await persistSessionState(session, {
      status: session.status,
    });

    logWhatsappEvent(
      session,
      canAutoRetry ? 'warning' : 'error',
      'pairing_failed',
      message,
      {
        statusCode,
        phase,
        naturalExpiry,
        failureCount: flow.failureCount,
        automaticRetry: canAutoRetry,
      }
    );

    dropSocketSession(session, {
      removeAuth: true,
      reason: 'Resetting failed WhatsApp pairing transport',
    });
  } else {
    void writeSystemLog({
      userId: flow.userId,
      sessionId: flow.sessionId,
      level: canAutoRetry ? 'warning' : 'error',
      source: 'whatsapp',
      event: 'pairing_failed',
      message,
      details: {
        statusCode,
        phase,
        naturalExpiry,
        failureCount: flow.failureCount,
        automaticRetry: canAutoRetry,
      },
    });
  }

  if (!canAutoRetry) {
    flow.active = false;

    void writeSystemLog({
      userId: flow.userId,
      sessionId: flow.sessionId,
      level: 'error',
      source: 'whatsapp',
      event: 'pairing_auto_retry_exhausted',
      message:
        'Automatic WhatsApp pairing retries stopped to avoid rate limiting',
      details: {
        failureCount: flow.failureCount,
        lastStatusCode: statusCode,
      },
    });

    return;
  }

  const delay = naturalExpiry
    ? 1_000
    : managedPairingRetryDelay(flow.failureCount);

  void writeSystemLog({
    userId: flow.userId,
    sessionId: flow.sessionId,
    level: 'info',
    source: 'whatsapp',
    event: 'pairing_auto_retry_scheduled',
    message: 'A new WhatsApp pairing code will be generated automatically',
    details: {
      delayMs: delay,
      failureCount: flow.failureCount,
      naturalExpiry,
    },
  });

  flow.retryTimer = setTimeout(() => {
    flow.retryTimer = null;

    if (!flow.active) return;

    void ensureManagedPairingAttempt(flow, {
      reason: naturalExpiry ? 'expired_code_retry' : 'auto_retry',
      forceNewCode: true,
    });
  }, delay);
}

async function ensureManagedPairingAttempt(
  flow,
  { reason = 'initial', forceNewCode = false } = {}
) {
  if (!flow?.active || flow.requestInFlight || flow.retryTimer) {
    return null;
  }

  if (managedPairingCodeIsVisible(flow) && !forceNewCode) {
    return {
      code: flow.code,
      issuedAt: flow.codeIssuedAt,
      phone: flow.phone,
      displayExpiresAt: flow.codeRotatesAt,
    };
  }

  let session = sessions.get(flow.sessionId);

  if (!isCurrentSession(session) || !session.socket) {
    session = await startSession(flow.sessionId, {
      userId: flow.userId,
    });
  }

  if (session.registered) {
    stopManagedPairingFlow(flow.sessionId);
    return null;
  }

  flow.requestInFlight = true;
  const attemptToken = ++flow.attemptToken;
  const socket = session.socket;

  try {
    await waitForPairingReady(session);

    if (
      !flow.active ||
      attemptToken !== flow.attemptToken ||
      !isCurrentSession(session) ||
      session.socket !== socket
    ) {
      return null;
    }

    if (session.registered) {
      stopManagedPairingFlow(flow.sessionId);
      return null;
    }

    clearManagedPairingTimers(flow);
    invalidateManagedPairingCode(flow);
    flow.lastError = null;

    session.status = 'STARTING';
    session.lastError = null;
    session.pairingAttemptActive = true;
    session.pairingRequestInFlight = true;
    session.pairingCode = null;
    session.pairingCodeIssuedAt = null;
    session.pairingPhone = flow.phone;

    await persistSessionState(session, {
      status: 'STARTING',
    });

    logWhatsappEvent(
      session,
      'info',
      'pairing_started',
      'WhatsApp pairing code requested',
      {
        reason,
        nextGeneration: flow.generation + 1,
      }
    );

    const candidateCode = await socket.requestPairingCode(
      flow.phoneDigits
    );

    // Do NOT publish the candidate immediately. Baileys currently returns the
    // code before WhatsApp has necessarily accepted companion_hello.
    await sleep(MANAGED_PAIRING_PUBLISH_GRACE_MS);

    if (
      !flow.active ||
      attemptToken !== flow.attemptToken ||
      !isCurrentSession(session) ||
      session.socket !== socket ||
      session.lastError ||
      session.registered
    ) {
      return null;
    }

    const issuedAt = new Date();
    flow.generation += 1;
    flow.code = candidateCode;
    flow.codeIssuedAt = issuedAt.toISOString();
    flow.codeRotatesAt = new Date(
      issuedAt.getTime() + MANAGED_PAIRING_ROTATE_MS
    ).toISOString();
    flow.published = true;
    flow.lastError = null;

    session.pairingCode = candidateCode;
    session.pairingCodeIssuedAt = flow.codeIssuedAt;
    session.pairingPhone = flow.phone;
    session.pairingAttemptActive = true;
    session.status = 'STARTING';
    session.lastError = null;

    logWhatsappEvent(
      session,
      'info',
      'pairing_code_created',
      'WhatsApp pairing code created',
      {
        generation: flow.generation,
        autoRefreshInMs: MANAGED_PAIRING_ROTATE_MS,
      }
    );

    await persistSessionState(session, {
      status: 'STARTING',
    });

    scheduleManagedPairingRotation(flow);

    return {
      code: flow.code,
      issuedAt: flow.codeIssuedAt,
      phone: flow.phone,
      displayExpiresAt: flow.codeRotatesAt,
    };
  } catch (error) {
    if (flow.active && attemptToken === flow.attemptToken) {
      const { statusCode, message } = disconnectDetails({ error });

      await handleManagedPairingFailure(flow, session, {
        statusCode,
        message: message || error.message,
        phase: 'request',
      });
    }

    return null;
  } finally {
    if (attemptToken === flow.attemptToken) {
      flow.requestInFlight = false;
    }

    if (isCurrentSession(session)) {
      session.pairingRequestInFlight = false;
    }
  }
}

function disconnectDetails(lastDisconnect) {
  const error = lastDisconnect?.error;

  const statusCode =
    error instanceof Boom
      ? error.output.statusCode
      : error?.output?.statusCode ||
        error?.data?.statusCode ||
        error?.statusCode ||
        null;

  const message =
    error?.message ||
    error?.output?.payload?.message ||
    "WhatsApp connection closed";

  return {
    statusCode,
    message,
  };
}

export function updatePolicyCache(sessionRow) {
  if (!sessionRow?.id) return;

  policyCache.set(sessionRow.id, {
    expiresAt: Date.now() + SESSION_POLICY_CACHE_MS,
    row: sessionRow,
  });
}

async function getTrackingPolicy(sessionId) {
  const cached = policyCache.get(sessionId);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.row;
  }

  if (!isSupabaseConfigured()) {
    return null;
  }

  const row = await repository.getWhatsappSessionById(sessionId);

  if (row) {
    updatePolicyCache(row);
  }

  return row;
}

async function getGroupName(socket, chatId) {
  const cached = groupNameCache.get(chatId);

  if (cached && Date.now() < cached.expiresAt) {
    return cached.name;
  }

  try {
    const metadata = await socket.groupMetadata(chatId);
    const name = metadata?.subject || null;

    groupNameCache.set(chatId, {
      name,
      expiresAt: Date.now() + GROUP_CACHE_TTL,
    });

    return name;
  } catch (error) {
    console.error(
      `[group] Could not get name for ${chatId}:`,
      error.message
    );

    return null;
  }
}

function getTextFromMessage(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    message?.documentMessage?.caption ||
    ""
  );
}

function getMessageType(message) {
  if (!message) return "unknown";

  if (message.conversation || message.extendedTextMessage) return "text";
  if (message.imageMessage) return "image";
  if (message.videoMessage) return "video";
  if (message.audioMessage) return "audio";
  if (message.documentMessage) return "document";
  if (message.stickerMessage) return "sticker";
  if (message.locationMessage) return "location";
  if (message.contactMessage) return "contact";
  if (message.reactionMessage) return "reaction";

  return Object.keys(message)[0] || "unknown";
}

function getMediaInfo(message) {
  const media =
    message?.imageMessage ||
    message?.videoMessage ||
    message?.audioMessage ||
    message?.documentMessage ||
    message?.stickerMessage ||
    null;

  if (!media) return null;

  return {
    mimetype: media.mimetype || null,
    fileName: media.fileName || null,
    fileLength:
      media.fileLength?.toString?.() ||
      media.fileLength ||
      null,
    caption: media.caption || null,
    seconds: media.seconds || null,
  };
}

async function sendToN8n(event) {
  if (!N8N_WEBHOOK_URL) {
    return false;
  }

  try {
    const response = await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[n8n] ${response.status}:`, body);

      void writeSystemLog({
        userId: event?.userId || null,
        sessionId: event?.session || null,
        level: "error",
        source: "n8n",
        event: "n8n_failed",
        message: `n8n returned HTTP ${response.status}`,
        details: {
          httpStatus: response.status,
          outboundEvent: event?.event || null,
          dbMessageId: event?.payload?.dbMessageId || null,
        },
      });

      return false;
    }

    console.log(`[n8n] delivered: ${event.event}`);

    void writeSystemLog({
      userId: event?.userId || null,
      sessionId: event?.session || null,
      level: "info",
      source: "n8n",
      event:
        event?.event === "message.received"
          ? "message_forwarded_to_n8n"
          : "event_forwarded_to_n8n",
      message: `Delivered ${event?.event || "event"} to n8n`,
      details: {
        outboundEvent: event?.event || null,
        dbMessageId: event?.payload?.dbMessageId || null,
      },
    });

    return true;
  } catch (error) {
    console.error("[n8n] webhook error:", error.message);

    void writeSystemLog({
      userId: event?.userId || null,
      sessionId: event?.session || null,
      level: "error",
      source: "n8n",
      event: "n8n_failed",
      message: error.message,
      details: {
        outboundEvent: event?.event || null,
        dbMessageId: event?.payload?.dbMessageId || null,
      },
    });

    return false;
  }
}

async function forwardSessionEvent(event) {
  if (!N8N_FORWARD_SESSION_EVENTS) {
    return false;
  }

  return sendToN8n(event);
}

async function persistSessionState(session, patch) {
  if (!session?.userId || !isSupabaseConfigured()) {
    return null;
  }

  try {
    const updated = await repository.updateWhatsappSessionById(
      session.id,
      patch
    );

    if (updated) {
      updatePolicyCache(updated);
    }

    return updated;
  } catch (error) {
    console.error(
      `[${session.id}] Supabase session update failed:`,
      error.message
    );
    return null;
  }
}

async function addSessionActivity(session, title, detail = "") {
  if (!session?.userId || !isSupabaseConfigured()) {
    return;
  }

  try {
    await repository.addActivity(session.userId, {
      type: "whatsapp",
      title,
      detail,
    });
  } catch (error) {
    console.error(
      `[${session.id}] activity write failed:`,
      error.message
    );
  }
}

async function maybeUpsertChat({
  sessionId,
  chatId,
  isGroup,
  chatName,
  messageTimestamp,
}) {
  if (!isSupabaseConfigured()) return;

  const cacheKey = `${sessionId}:${chatId}:${chatName || ""}`;
  const cachedUntil = chatWriteCache.get(cacheKey);

  if (cachedUntil && cachedUntil > Date.now()) {
    return;
  }

  chatWriteCache.set(cacheKey, Date.now() + CHAT_WRITE_TTL);

  try {
    await repository.upsertChat({
      sessionId,
      chatId,
      chatType: isGroup ? "group" : "private",
      name: chatName,
      lastMessageAt: messageTimestamp,
    });
  } catch (error) {
    chatWriteCache.delete(cacheKey);
    console.error(
      `[${sessionId}] chat metadata write failed:`,
      error.message
    );
  }
}

async function processMessage(session, socket, message) {
  const chatId = message?.key?.remoteJid;
  const whatsappMessageId = message?.key?.id;

  if (!chatId || !whatsappMessageId || !message?.message) {
    return;
  }

  const messageType = getMessageType(message.message);

  if (!TRACKABLE_MESSAGE_TYPES.has(messageType)) {
    return;
  }

  const policy = await getTrackingPolicy(session.id);

  // Legacy/unmanaged sessions and RidePicker OFF never enter the DB or n8n.
  if (!policy || policy.bot_mode === "off") {
    return;
  }

  const messageTimestamp = isoFromWhatsappTimestamp(
    message.messageTimestamp
  );

  if (
    policy.bot_enabled_at &&
    new Date(messageTimestamp).getTime() <
      new Date(policy.bot_enabled_at).getTime()
  ) {
    return;
  }

  const fromMe = Boolean(message.key.fromMe);
  const isGroup = chatId.endsWith("@g.us");
  const participant = message.key.participant || null;
  const participantAlt = message.key.participantAlt || null;
  const sender = participantAlt || participant || chatId;
  const senderName = message.pushName || null;
  const body = getTextFromMessage(message.message);
  const media = getMediaInfo(message.message);

  let chatName = null;

  if (isGroup) {
    chatName = await getGroupName(socket, chatId);
  } else if (!fromMe) {
    chatName = senderName;
  }

  let inserted = null;

  try {
    inserted = await repository.insertMessage({
      session_id: session.id,
      whatsapp_message_id: whatsappMessageId,
      chat_id: chatId,
      chat_name: chatName,
      sender_id: sender,
      sender_name: senderName,
      body: body || null,
      is_group: isGroup,
      from_me: fromMe,
      message_type: messageType,
      has_media: Boolean(media),
      media,
      message_timestamp: messageTimestamp,
      processing_status:
        fromMe && !N8N_FORWARD_FROM_ME ? "ignored" : "new",
    });
  } catch (error) {
    // The DB trigger is our second line of defence against OFF/history messages.
    console.error(
      `[${session.id}] message insert rejected:`,
      error.message
    );
    return;
  }

  // Ignore duplicates. PostgREST returns no inserted row when
  // resolution=ignore-duplicates matched the unique constraint.
  if (!inserted) {
    return;
  }

  maybeUpsertChat({
    sessionId: session.id,
    chatId,
    isGroup,
    chatName,
    messageTimestamp,
  });

  console.log(
    `[${session.id}]`,
    fromMe ? "ME" : senderName || sender,
    "→",
    chatName || chatId,
    ":",
    body || `[${messageType}]`
  );

  // By default outgoing messages are context-only. For temporary testing,
  // N8N_FORWARD_FROM_ME=true also forwards manually sent messages to n8n.
  // IMPORTANT: turn this back off before automated replies/autopilot are enabled
  // to avoid feeding bot-generated outbound messages back into the AI pipeline.
  if (fromMe && !N8N_FORWARD_FROM_ME) {
    return;
  }

  const hasText = Boolean(String(body || "").trim());

  if (!hasText && !N8N_FORWARD_MEDIA_WITHOUT_TEXT) {
    await repository.updateMessage(inserted.id, {
      processing_status: "ignored",
    });
    return;
  }

  const event = {
    event: "message.received",
    userId: policy.user_id,
    session: session.id,
    timestamp: Date.now(),
    payload: {
      id: whatsappMessageId,
      dbMessageId: inserted.id,
      chatId,
      chatName,
      isGroup,
      sender,
      senderName,
      participant,
      participantAlt,
      fromMe,
      direction: fromMe ? "outgoing" : "incoming",
      body,
      type: messageType,
      hasMedia: Boolean(media),
      media,
      messageTimestamp,
    },
  };

  const delivered = await sendToN8n(event);

  if (delivered) {
    await repository.updateMessage(inserted.id, {
      processing_status: "sent_to_ai",
      forwarded_to_n8n_at: new Date().toISOString(),
    });
  }
}

export function getSession(id) {
  return sessions.get(id);
}

export function getSessions() {
  return Array.from(sessions.entries()).map(([id, session]) => ({
    id,
    userId: session.userId || null,
    status: session.status,
    pairingCode:
      managedPairingFlows.get(id)?.code || session.pairingCode || null,
  }));
}

export async function startSession(
  id,
  { userId = null } = {}
) {
  const existing = sessions.get(id);

  if (existing?.socket) {
    if (userId && !existing.userId) {
      existing.userId = userId;
    }
    return existing;
  }

  const authPath = authPathFor(id);
  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  const session = {
    id,
    userId,
    socket: null,
    qr: null,
    qrIssuedAt: null,
    pairingCode: null,
    pairingCodeIssuedAt: null,
    pairingPhone: null,
    pairingReady: false,
    pairingReadyResolvers: [],
    pairingRequestInFlight: false,
    pairingAttemptActive: false,
    status: "STARTING",
    registered: Boolean(state?.creds?.registered),
    reconnectTimer: null,
    lastError: null,
    disposed: false,
  };

  sessions.set(id, session);

  // Keep the socket configuration intentionally small and use Baileys defaults.
  // This is the previously stable RidePicker socket configuration.
  const socket = makeWASocket({
    auth: state,
    markOnlineOnConnect: false,
    printQRInTerminal: false,
  });

  session.socket = socket;

  socket.ev.on("creds.update", async () => {
    if (!isCurrentSession(session)) return;

    await saveCreds();

    const wasRegistered = session.registered;
    session.registered = Boolean(state?.creds?.registered);

    if (!wasRegistered && session.registered) {
      console.log(`[${id}] WhatsApp credentials registered`);
      logWhatsappEvent(
        session,
        "info",
        "credentials_registered",
        "WhatsApp credentials registered"
      );
    }
  });

  socket.ev.on("connection.update", async (update) => {
    if (!isCurrentSession(session)) return;

    const { connection, qr, lastDisconnect } = update;
    const managedPairingFlow = managedPairingFlows.get(id) || null;

    // Pairing-code auth must wait for the first QR challenge. This mirrors
    // the official Baileys example and avoids asking for a phone code while
    // the socket is only in the generic `connecting` phase.
    if (qr && !session.registered) {
      resolvePairingReady(session);
    }

    if (qr) {
      session.qr = await QRCode.toDataURL(qr);
      session.qrIssuedAt = new Date().toISOString();

      if (!isCurrentSession(session)) return;

      console.log(`[${id}] QR ready`);
      logWhatsappEvent(
        session,
        "info",
        "qr_ready",
        "WhatsApp QR fallback is ready"
      );

      if (managedPairingFlow?.active) {
        session.status = "STARTING";

        await persistSessionState(session, {
          status: "STARTING",
        });

        void ensureManagedPairingAttempt(managedPairingFlow, {
          reason: "qr_ready",
        });
      } else {
        session.status = "QR";

        await persistSessionState(session, {
          status: "QR",
        });
      }
    }

    if (connection === "open") {
      clearReconnectTimer(session);

      const actuallyRegistered = await waitForRegisteredSession(
        session,
        socket
      );

      if (!actuallyRegistered) {
        session.status = "ERROR";
        session.lastError = {
          code: "UNREGISTERED_OPEN",
          message:
            "WhatsApp socket opened without confirmed registered credentials.",
        };

        console.error(
          `[${id}] refusing false CONNECTED state: credentials are not registered`
        );

        logWhatsappEvent(
          session,
          "error",
          "connection_validation_failed",
          "Socket opened without confirmed registered credentials",
          { code: "UNREGISTERED_OPEN" }
        );

        await persistSessionState(session, {
          status: "ERROR",
        });

        return;
      }

      stopManagedPairingFlow(id);

      session.qr = null;
      session.qrIssuedAt = null;
      session.pairingCode = null;
      session.pairingCodeIssuedAt = null;
      session.pairingPhone = null;
      session.pairingAttemptActive = false;
      session.status = "CONNECTED";
      session.lastError = null;

      const account = socketAccount(socket);
      const connectedAt = new Date().toISOString();

      console.log(`[${id}] WhatsApp connected`);
      logWhatsappEvent(
        session,
        "info",
        "whatsapp_connected",
        "WhatsApp connected"
      );

      await persistSessionState(session, {
        status: "CONNECTED",
        whatsapp_phone: account.phone,
        display_name: account.name,
        connected_at: connectedAt,
        last_seen_at: connectedAt,
      });

      await addSessionActivity(
        session,
        "WhatsApp connected",
        account.phone || ""
      );

      await forwardSessionEvent({
        event: "session.connected",
        session: id,
        userId: session.userId,
        timestamp: Date.now(),
      });
    }

    if (connection === "close") {
      const { statusCode, message } = disconnectDetails(lastDisconnect);

      console.warn(
        `[${id}] WhatsApp connection closed`,
        JSON.stringify({
          statusCode,
          message,
          registered: session.registered,
          pairingAttemptActive: session.pairingAttemptActive,
        })
      );

      logWhatsappEvent(
        session,
        "warning",
        "whatsapp_connection_closed",
        message,
        {
          statusCode,
          registered: session.registered,
          pairingAttemptActive: session.pairingAttemptActive,
        }
      );

      session.socket = null;
      session.lastError = {
        code: statusCode,
        message,
      };

      // creds.update is asynchronous. Read the live auth state again before
      // deciding whether a 515 is a successful post-pairing restart.
      session.registered = Boolean(
        session.registered || state?.creds?.registered
      );

      const restartRequired =
        statusCode === DisconnectReason.restartRequired;
      const managedFlow = managedPairingFlows.get(id) || null;

      // creds.update and connection.update are separate async event streams.
      // Give a 515 a very short grace period so a legitimate pair-success can
      // finish marking credentials as registered before we classify it as a
      // failed pairing attempt.
      if (restartRequired && managedFlow?.active && !session.registered) {
        await sleep(500);
        session.registered = Boolean(
          session.registered || state?.creds?.registered
        );
      }

      // For a managed phone-code pairing attempt, any transport close before
      // credentials are actually registered invalidates the current code.
      // We never keep showing a dead code. The backend automatically creates a
      // clean socket and a new code using bounded backoff.
      if (managedFlow?.active && !session.registered) {
        await handleManagedPairingFailure(managedFlow, session, {
          statusCode,
          message,
          phase: "connection",
        });
        return;
      }

      // 515/restartRequired is normal only AFTER the credentials have really
      // registered. Preserve auth and reconnect instead of wiping it.
      if (restartRequired && session.registered) {
        stopManagedPairingFlow(id);
        session.status = "RECONNECTING";

        console.log(
          `[${id}] WhatsApp requested restart after pairing/authentication`
        );
        logWhatsappEvent(
          session,
          "info",
          "whatsapp_restart_required",
          "WhatsApp requested restart after pairing/authentication",
          { statusCode }
        );

        await persistSessionState(session, {
          status: "RECONNECTING",
        });

        if (!session.reconnectTimer) {
          session.reconnectTimer = setTimeout(async () => {
            session.reconnectTimer = null;

            if (!isCurrentSession(session)) return;

            const userId = session.userId;
            dropSocketSession(session, {
              removeAuth: false,
              reason: "Restarting registered WhatsApp session",
            });

            try {
              await startSession(id, {
                userId,
              });
            } catch (error) {
              console.error(`[${id}] restart failed:`, error);
              void writeSystemLog({
                userId,
                sessionId: id,
                level: "error",
                source: "whatsapp",
                event: "restart_failed",
                message: error.message,
                details: { error },
              });

              await repository.updateWhatsappSessionById(id, {
                status: "ERROR",
              });
            }
          }, 750);
        }

        return;
      }

      // Legacy/internal pairing endpoint compatibility. Managed user pairing
      // is handled above by managedPairingFlows.
      if (!session.registered && session.pairingAttemptActive) {
        clearReconnectTimer(session);
        session.status = "ERROR";
        session.pairingAttemptActive = false;
        session.pairingRequestInFlight = false;
        session.pairingCode = null;
        session.pairingCodeIssuedAt = null;
        session.pairingPhone = null;

        console.error(
          `[${id}] legacy pairing failed before credentials were registered`,
          JSON.stringify({ statusCode, message })
        );
        logWhatsappEvent(
          session,
          "error",
          "pairing_failed",
          message,
          {
            statusCode,
            registered: session.registered,
            managed: false,
          }
        );

        await persistSessionState(session, {
          status: "ERROR",
        });

        return;
      }

      // Only a non-pairing 401 is a genuine WhatsApp logout.
      if (statusCode === DisconnectReason.loggedOut) {
        stopManagedPairingFlow(id);
        clearReconnectTimer(session);
        session.status = "LOGGED_OUT";
        session.qr = null;
        session.pairingCode = null;
        session.pairingCodeIssuedAt = null;
        session.pairingPhone = null;
        session.pairingAttemptActive = false;

        console.log(`[${id}] WhatsApp logged out`);
        logWhatsappEvent(
          session,
          "info",
          "whatsapp_logged_out",
          "WhatsApp logged out",
          { statusCode }
        );

        await persistSessionState(session, {
          status: "LOGGED_OUT",
          bot_mode: "off",
          whatsapp_phone: null,
          display_name: null,
          connected_at: null,
        });

        await addSessionActivity(session, "WhatsApp disconnected", "");

        await forwardSessionEvent({
          event: "session.logged_out",
          session: id,
          userId: session.userId,
          timestamp: Date.now(),
        });

        return;
      }

      session.status = "RECONNECTING";
      console.log(`[${id}] reconnecting...`);
      logWhatsappEvent(
        session,
        "warning",
        "reconnect_started",
        "WhatsApp reconnect started",
        { statusCode, reason: message }
      );

      // Do NOT change bot_mode here. Assist remains enabled and resumes when
      // WhatsApp comes back.
      await persistSessionState(session, {
        status: "RECONNECTING",
      });

      await forwardSessionEvent({
        event: "session.reconnecting",
        session: id,
        userId: session.userId,
        timestamp: Date.now(),
      });

      if (!session.reconnectTimer) {
        session.reconnectTimer = setTimeout(async () => {
          session.reconnectTimer = null;

          if (!isCurrentSession(session)) return;

          const userId = session.userId;
          dropSocketSession(session, {
            removeAuth: false,
            reason: "Reconnecting WhatsApp session",
          });

          try {
            await startSession(id, {
              userId,
            });
          } catch (error) {
            console.error(`[${id}] reconnect failed:`, error);
            logWhatsappEvent(
              session,
              "error",
              "reconnect_failed",
              error.message,
              { error }
            );

            await persistSessionState(session, {
              status: "ERROR",
            });
          }
        }, 2000);
      }
    }
  });

  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (!isCurrentSession(session)) return;

    if (type !== "notify") {
      return;
    }

    for (const message of messages) {
      try {
        await processMessage(session, socket, message);
      } catch (error) {
        console.error(
          `[${id}] message processing failed:`,
          error.message
        );
        logWhatsappEvent(
          session,
          "error",
          "message_processing_failed",
          error.message,
          { whatsappMessageId: message?.key?.id || null }
        );
      }
    }
  });

  await persistSessionState(session, {
    status: "STARTING",
  });

  return session;
}

export async function requestPairingCode({
  sessionId,
  userId = null,
  phone,
}) {
  const session = await startSession(sessionId, {
    userId,
  });

  if (session.registered) {
    const error = new Error(
      "WhatsApp session is already registered. Disconnect it before requesting a new pairing code."
    );
    error.status = 409;
    throw error;
  }

  if (!session.socket?.requestPairingCode) {
    const error = new Error(
      "This Baileys build does not support pairing codes."
    );
    error.status = 501;
    throw error;
  }

  if (session.pairingRequestInFlight) {
    const error = new Error(
      "A WhatsApp pairing code request is already in progress."
    );
    error.status = 409;
    throw error;
  }

  const digits = phoneDigits(phone);

  // Wait for the QR challenge. The official Baileys example requests the
  // phone pairing code from the QR update, which is a stronger readiness
  // signal than the generic `connecting` state.
  await waitForPairingReady(session);

  if (session.registered) {
    const error = new Error(
      "WhatsApp session became registered while preparing the pairing code."
    );
    error.status = 409;
    throw error;
  }

  session.pairingRequestInFlight = true;
  session.pairingAttemptActive = true;
  session.lastError = null;

  try {
    console.log(
      `[${sessionId}] requesting pairing code for +${digits}`
    );
    logWhatsappEvent(
      session,
      "info",
      "pairing_started",
      "WhatsApp pairing code requested"
    );

    const code = await session.socket.requestPairingCode(digits);

    session.pairingCode = code;
    session.pairingCodeIssuedAt = new Date().toISOString();
    session.pairingPhone = `+${digits}`;

    console.log(`[${sessionId}] pairing code ready`);
    logWhatsappEvent(
      session,
      "info",
      "pairing_code_created",
      "WhatsApp pairing code created"
    );

    // Return the pairing code immediately. The frontend should show it as soon
    // as Baileys creates it while the connection lifecycle continues normally.

    await persistSessionState(session, {
      status: "STARTING",
    });

    return {
      code,
      issuedAt: session.pairingCodeIssuedAt,
      phone: session.pairingPhone,
    };
  } catch (error) {
    session.pairingAttemptActive = false;
    session.pairingCode = null;
    session.pairingCodeIssuedAt = null;
    session.pairingPhone = null;
    session.lastError = {
      code: error?.output?.statusCode || error?.statusCode || null,
      message: error.message,
    };

    console.error(
      `[${sessionId}] pairing code request failed:`,
      error
    );
    logWhatsappEvent(
      session,
      "error",
      "pairing_failed",
      error.message,
      {
        statusCode:
          error?.output?.statusCode || error?.statusCode || null,
      }
    );

    await persistSessionState(session, {
      status: "ERROR",
    });

    throw error;
  } finally {
    session.pairingRequestInFlight = false;
  }
}

export async function startManagedSession(
  userId,
  { method = "qr", phone = null } = {}
) {
  if (!isSupabaseConfigured()) {
    const error = new Error("Supabase is not configured");
    error.status = 503;
    throw error;
  }

  if (method === "pairing_code") {
    return requestManagedPairingCode(userId, phone);
  }

  const user = await repository.getUserRowById(userId);

  if (!user) {
    const error = new Error("user not found");
    error.status = 404;
    throw error;
  }

  const dbSession = await repository.ensureWhatsappSession(userId);

  if (!dbSession) {
    throw new Error("Could not create WhatsApp session");
  }

  const session = await startSession(dbSession.id, {
    userId,
  });

  const latest = await repository.getWhatsappSessionByUser(userId);
  return normalizeManagedSession(latest, session);
}

export async function getManagedSession(userId) {
  if (!isSupabaseConfigured()) {
    const error = new Error("Supabase is not configured");
    error.status = 503;
    throw error;
  }

  const dbSession = await repository.getWhatsappSessionByUser(userId);

  if (!dbSession) {
    return null;
  }

  const memorySession = sessions.get(dbSession.id) || null;

  return normalizeManagedSession(dbSession, memorySession);
}

export async function refreshManagedSession(userId) {
  return getManagedSession(userId);
}

export async function requestManagedPairingCode(userId, phone = null) {
  if (!isSupabaseConfigured()) {
    const error = new Error("Supabase is not configured");
    error.status = 503;
    throw error;
  }

  const dbSession = await repository.ensureWhatsappSession(userId);
  const user = await repository.getUserRowById(userId);

  if (!user) {
    const error = new Error("user not found");
    error.status = 404;
    throw error;
  }

  let session = sessions.get(dbSession.id) || null;

  if (session?.registered || dbSession.status === "CONNECTED") {
    if (!session?.registered && dbSession.status === "CONNECTED") {
      session = await startSession(dbSession.id, {
        userId,
      });
    }

    if (session?.registered) {
      const error = new Error(
        "WhatsApp is already connected. Disconnect it before requesting a new pairing code."
      );
      error.status = 409;
      throw error;
    }
  }

  const pairingPhone = phone || user.phone_e164;
  const existingFlow = managedPairingFlows.get(dbSession.id) || null;
  const hadVisibleCode = managedPairingCodeIsVisible(existingFlow);

  const flow = ensureManagedPairingFlow({
    sessionId: dbSession.id,
    userId,
    phone: pairingPhone,
  });

  // A POST while a code is already visible means the user explicitly tapped
  // "Generate new code". Rotate immediately. Ordinary frontend polling uses
  // GET and therefore never rotates the code by accident.
  if (hadVisibleCode) {
    clearManagedPairingTimers(flow);
    flow.failureCount = 0;
    invalidateManagedPairingCode(flow);

    if (isCurrentSession(session)) {
      session.pairingCode = null;
      session.pairingCodeIssuedAt = null;
      session.status = "STARTING";
      session.lastError = null;

      await persistSessionState(session, {
        status: "STARTING",
      });
    }
  }

  // A terminal/exhausted previous attempt must start with a completely fresh
  // auth directory. A registered CONNECTED session is handled above and is
  // never deleted here.
  if (!session?.registered && !flow.requestInFlight && !flow.retryTimer) {
    if (
      !session ||
      !isCurrentSession(session) ||
      dbSession.status === "ERROR" ||
      dbSession.status === "LOGGED_OUT" ||
      dbSession.status === "DISCONNECTED"
    ) {
      if (session && isCurrentSession(session)) {
        dropSocketSession(session, {
          removeAuth: true,
          reason: "Starting fresh managed WhatsApp pairing",
        });
      } else {
        removeAuthDirectory(dbSession.id);
      }

      session = await startSession(dbSession.id, {
        userId,
      });
    }

    void ensureManagedPairingAttempt(flow, {
      reason: hadVisibleCode ? "manual_refresh" : "manual_start",
      forceNewCode: hadVisibleCode,
    });
  }

  const latest = await repository.getWhatsappSessionByUser(userId);
  return normalizeManagedSession(latest, sessions.get(dbSession.id) || session);
}

export async function refreshManagedQr(userId) {
  const dbSession = await repository.getWhatsappSessionByUser(userId);

  if (!dbSession) {
    return startManagedSession(userId, {
      method: "qr",
    });
  }

  let session = sessions.get(dbSession.id);

  if (!session?.socket) {
    if (dbSession.status === "LOGGED_OUT") {
      removeAuthDirectory(dbSession.id);
    }

    session = await startSession(dbSession.id, {
      userId,
    });
  }

  const latest = await repository.getWhatsappSessionByUser(userId);
  return normalizeManagedSession(latest, session);
}

export async function retryManagedSession(userId) {
  const dbSession = await repository.getWhatsappSessionByUser(userId);

  if (!dbSession) {
    return startManagedSession(userId, {
      method: "qr",
    });
  }

  stopManagedPairingFlow(dbSession.id);

  const current = sessions.get(dbSession.id);

  if (current) {
    clearReconnectTimer(current);
    try {
      current.socket?.end?.(new Error("manual reconnect"));
    } catch {
      // Socket may already be closed.
    }
    sessions.delete(dbSession.id);
  }

  const session = await startSession(dbSession.id, {
    userId,
  });

  const latest = await repository.getWhatsappSessionByUser(userId);
  return normalizeManagedSession(latest, session);
}

export async function disconnectSession(sessionId) {
  stopManagedPairingFlow(sessionId);

  const session = sessions.get(sessionId);

  if (session) {
    clearReconnectTimer(session);

    try {
      if (session.socket) {
        await session.socket.logout();
      }
    } catch (error) {
      console.warn(`[${sessionId}] logout warning:`, error.message);
    }

    sessions.delete(sessionId);
  }

  removeAuthDirectory(sessionId);
}

export async function disconnectManagedSession(userId) {
  const dbSession = await repository.getWhatsappSessionByUser(userId);

  if (!dbSession) {
    return null;
  }

  await disconnectSession(dbSession.id);

  const updated = await repository.updateWhatsappSessionById(
    dbSession.id,
    {
      status: "LOGGED_OUT",
      bot_mode: "off",
      whatsapp_phone: null,
      display_name: null,
      connected_at: null,
    }
  );

  updatePolicyCache(updated);

  await repository.addActivity(userId, {
    type: "whatsapp",
    title: "WhatsApp disconnected",
    detail: "",
  });

  void writeSystemLog({
    userId,
    sessionId: dbSession.id,
    level: "info",
    source: "whatsapp",
    event: "whatsapp_disconnected",
    message: "WhatsApp disconnected by user",
    details: { reason: "manual_disconnect" },
  });

  return normalizeManagedSession(updated, null);
}

function normalizeManagedSession(dbSession, memorySession) {
  if (!dbSession && !memorySession) {
    return null;
  }

  const sessionId = memorySession?.id || dbSession?.id || null;
  const managedFlow = sessionId
    ? managedPairingFlows.get(sessionId) || null
    : null;

  let status = memorySession?.status || dbSession?.status || "DISCONNECTED";

  // While automatic pairing is active, QR is only an internal readiness
  // signal. The user-facing state remains STARTING until a phone code is
  // published, refreshed, connected, or the bounded retry circuit opens.
  if (
    managedFlow?.active &&
    status !== "CONNECTED" &&
    status !== "RECONNECTING"
  ) {
    status = "STARTING";
  }

  const qrDataUrl = memorySession?.qr || null;
  const qrIssuedAt = memorySession?.qrIssuedAt || null;

  const managedCode = managedPairingCodeIsVisible(managedFlow)
    ? managedFlow.code
    : null;

  const legacyCode = legacyPairingCodeIsFresh(memorySession)
    ? memorySession.pairingCode
    : null;

  const pairingCode = managedCode || legacyCode;
  const pairingIssuedAt = managedCode
    ? managedFlow.codeIssuedAt
    : legacyCode
    ? memorySession?.pairingCodeIssuedAt || null
    : null;
  const pairingPhone = managedCode
    ? managedFlow.phone
    : memorySession?.pairingPhone || null;
  const pairingDisplayExpiresAt = managedCode
    ? managedFlow.codeRotatesAt
    : pairingIssuedAt
    ? new Date(
        new Date(pairingIssuedAt).getTime() +
          LEGACY_PAIRING_CODE_DISPLAY_TTL
      ).toISOString()
    : null;

  return {
    sessionId,
    status: toFrontendWhatsappStatus(status),
    account:
      dbSession?.whatsapp_phone || dbSession?.display_name
        ? {
            name: dbSession.display_name || "WhatsApp account",
            phone: dbSession.whatsapp_phone || null,
          }
        : null,
    connectedAt: dbSession?.connected_at || null,
    qr: qrDataUrl
      ? {
          id: `qr_${qrIssuedAt || Date.now()}`,
          payload: null,
          imageDataUrl: qrDataUrl,
          issuedAt: qrIssuedAt,
          expiresAt: null,
        }
      : null,
    pairingCode: pairingCode
      ? {
          code: pairingCode,
          phone: pairingPhone,
          issuedAt: pairingIssuedAt,
          // This is the planned automatic rotation time, not a claim that
          // WhatsApp guarantees validity until this exact timestamp.
          displayExpiresAt: pairingDisplayExpiresAt,
        }
      : null,
    error:
      managedFlow?.lastError || memorySession?.lastError || null,
  };
}

export async function sendText({
  sessionId,
  chatId,
  text,
}) {
  const session = sessions.get(sessionId);

  if (
    !session ||
    !session.socket ||
    session.status !== "CONNECTED"
  ) {
    throw new Error("Session is not connected");
  }

  if (!chatId) {
    throw new Error("chatId is required");
  }

  if (!text) {
    throw new Error("text is required");
  }

  return session.socket.sendMessage(chatId, {
    text,
  });
}

async function restoreManagedSessions() {
  if (!isSupabaseConfigured()) {
    return false;
  }

  const dbSessions = await repository.listWhatsappSessions();

  for (const dbSession of dbSessions) {
    const authPath = authPathFor(dbSession.id);

    if (!fs.existsSync(authPath)) {
      if (
        !["LOGGED_OUT", "DISCONNECTED"].includes(dbSession.status)
      ) {
        void writeSystemLog({
          userId: dbSession.user_id,
          sessionId: dbSession.id,
          level: "warning",
          source: "whatsapp",
          event: "auth_state_missing",
          message: "WhatsApp auth directory is missing during restore",
          details: { previousStatus: dbSession.status },
        });

        await repository.updateWhatsappSessionById(dbSession.id, {
          status: "DISCONNECTED",
        });
      }
      continue;
    }

    if (["LOGGED_OUT", "DISCONNECTED"].includes(dbSession.status)) {
      continue;
    }

    // Phone pairing is intentionally memory-driven and auto-rotating. After a
    // process restart there is no trustworthy live code/timer to resume. Clear
    // half-finished pairing auth instead of reviving stale credentials. Fully
    // registered CONNECTED/RECONNECTING sessions still restore normally.
    if (["STARTING", "QR", "ERROR"].includes(dbSession.status)) {
      removeAuthDirectory(dbSession.id);

      await repository.updateWhatsappSessionById(dbSession.id, {
        status: "DISCONNECTED",
      });

      void writeSystemLog({
        userId: dbSession.user_id,
        sessionId: dbSession.id,
        level: "info",
        source: "whatsapp",
        event: "pairing_reset_after_restart",
        message:
          "Incomplete WhatsApp pairing was reset after process restart",
        details: { previousStatus: dbSession.status },
      });

      continue;
    }

    console.log(`Restoring managed session: ${dbSession.id}`);
    void writeSystemLog({
      userId: dbSession.user_id,
      sessionId: dbSession.id,
      level: "info",
      source: "whatsapp",
      event: "session_restore_started",
      message: "Restoring managed WhatsApp session",
      details: { previousStatus: dbSession.status },
    });

    try {
      await startSession(dbSession.id, {
        userId: dbSession.user_id,
      });
    } catch (error) {
      console.error(
        `Failed restoring managed session ${dbSession.id}:`,
        error
      );
      void writeSystemLog({
        userId: dbSession.user_id,
        sessionId: dbSession.id,
        level: "error",
        source: "whatsapp",
        event: "session_restore_failed",
        message: error.message,
        details: { error },
      });
    }
  }

  return true;
}

async function restoreLegacySessions() {
  if (!RESTORE_LEGACY_SESSIONS) {
    return;
  }

  if (!fs.existsSync(DATA_DIR)) {
    return;
  }

  const entries = fs.readdirSync(DATA_DIR, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (!entry.isDirectory() || sessions.has(entry.name)) {
      continue;
    }

    console.log(`Restoring legacy session: ${entry.name}`);

    try {
      await startSession(entry.name);
    } catch (error) {
      console.error(
        `Failed restoring legacy session ${entry.name}:`,
        error
      );
    }
  }
}

export async function restoreSessions() {
  try {
    await restoreManagedSessions();
  } catch (error) {
    console.error("Managed session restore failed:", error.message);
  }

  await restoreLegacySessions();
}