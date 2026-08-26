import { randomBytes } from "crypto";
import QRCode from "qrcode";
import { Boom } from "@hapi/boom";

import makeWASocket, {
  DisconnectReason,
  fetchLatestWaWebVersion,
  aesEncryptCTR,
  bytesToCrockford,
  derivePairingCodeKey,
  getBinaryNodeChild,
  jidEncode,
  S_WHATSAPP_NET,
} from "@whiskeysockets/baileys";

import {
  N8N_FORWARD_MEDIA_WITHOUT_TEXT,
  N8N_FORWARD_FROM_ME,
  N8N_FORWARD_SESSION_EVENTS,
  N8N_WEBHOOK_URL,
  SESSION_POLICY_CACHE_MS,
} from "./config.js";
import { repository } from "./repository.js";
import { writeSystemLog } from "./systemLog.js";
import { createBaileysRawLogger } from "./whatsapp/logging/baileysLogger.js";
import {
  clearSupabaseAuthState,
  hasSupabaseAuthState,
  loadSupabaseAuthState,
} from "./whatsapp/auth/supabaseAuthStore.js";
import { isSupabaseConfigured } from "./supabase.js";
import {
  isoFromWhatsappTimestamp,
  phoneDigits,
  toFrontendWhatsappStatus,
} from "./utils.js";


const BAILEYS_RAW_LOGGING_V1 = true;
const sessions = new Map();
const managedPairingFlows = new Map();
const groupNameCache = new Map();
const policyCache = new Map();
const chatWriteCache = new Map();
const unexpectedLogoutRecoveryAttempts = new Map();

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
const WA_REMOTE_LOGOUT_V2 = true;
const WA_PAIRING_HARDENING_V1 = true;
const WA_PAIRING_QUERY_ACK_V2 = true;
const WA_PAIRING_UX_V1 = true;
const WA_PAIRING_FEEDBACK_V1 = true;
const BAILEYS_RAW_UI_ERRORS_V1 = true;
const PAIRING_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
// Unsolicited 401s are ambiguous in Baileys v7. Retry them with the same
// registered Supabase auth before asking the user to pair again. Never hammer
// WhatsApp indefinitely if the companion really was removed.
const UNEXPECTED_LOGOUT_RETRY_DELAYS_MS = [2_000, 10_000, 30_000];
const WA_WEB_VERSION_CACHE_MS = 10 * 60 * 1000;

let cachedWaWebVersion = null;
let cachedWaWebVersionExpiresAt = 0;

async function resolveWaWebVersion() {
  if (
    cachedWaWebVersion &&
    Date.now() < cachedWaWebVersionExpiresAt
  ) {
    return cachedWaWebVersion;
  }

  try {
    const result = await fetchLatestWaWebVersion({
      signal: AbortSignal.timeout(5_000),
    });
    const version = Array.isArray(result?.version)
      ? result.version
      : null;

    if (version?.length === 3) {
      cachedWaWebVersion = version;
      cachedWaWebVersionExpiresAt =
        Date.now() + WA_WEB_VERSION_CACHE_MS;
      console.log(
        `[whatsapp] using WA Web version ${version.join(".")}`
      );
      return version;
    }
  } catch (error) {
    console.warn(
      "[whatsapp] could not fetch current WA Web version:",
      error.message
    );
  }

  return null;
}

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

async function requestVerifiedPairingCode(
  session,
  socket,
  phoneDigits
) {
  const authState = socket?.authState;

  if (!authState?.creds || !socket?.query) {
    const error = new Error("WhatsApp pairing transport is not ready");
    error.status = 409;
    throw error;
  }

  const pairingCode = bytesToCrockford(randomBytes(5));
  authState.creds.pairingCode = pairingCode;

  const jid = jidEncode(phoneDigits, "s.whatsapp.net");
  const salt = randomBytes(32);
  const randomIv = randomBytes(16);
  const key = await derivePairingCodeKey(pairingCode, salt);
  const ciphered = aesEncryptCTR(
    authState.creds.pairingEphemeralKeyPair.public,
    key,
    randomIv
  );
  const wrappedEphemeralKey = Buffer.concat([salt, randomIv, ciphered]);

  try {
    // Mirror the upstream pairing fix: use query() so this promise is tied to
    // the actual companion_hello IQ response instead of returning an optimistic
    // local code before WhatsApp has accepted it.
    const result = await socket.query(
      {
        tag: "iq",
        attrs: {
          to: S_WHATSAPP_NET,
          type: "set",
          xmlns: "md",
        },
        content: [
          {
            tag: "link_code_companion_reg",
            attrs: {
              jid,
              stage: "companion_hello",
              should_show_push_notification: "true",
            },
            content: [
              {
                tag: "link_code_pairing_wrapped_companion_ephemeral_pub",
                attrs: {},
                content: wrappedEphemeralKey,
              },
              {
                tag: "companion_server_auth_key_pub",
                attrs: {},
                content: authState.creds.noiseKey.public,
              },
              {
                tag: "companion_platform_id",
                attrs: {},
                content: "1",
              },
              {
                tag: "companion_platform_display",
                attrs: {},
                content: "Chrome (Mac OS)",
              },
              {
                tag: "link_code_pairing_nonce",
                attrs: {},
                content: "0",
              },
            ],
          },
        ],
      },
      15_000
    );

    if (!result) {
      const error = new Error(
        "WhatsApp timed out while registering the pairing code."
      );
      error.status = 504;
      throw error;
    }

    const registrationNode = getBinaryNodeChild(
      result,
      "link_code_companion_reg"
    );
    const pairingRefNode = registrationNode
      ? getBinaryNodeChild(registrationNode, "link_code_pairing_ref")
      : null;

    if (!pairingRefNode) {
      const error = new Error(
        "WhatsApp did not return a pairing reference for the new code."
      );
      error.status = 502;
      throw error;
    }

    // Persist through the normal creds.update listener. This keeps the auth
    // writer scoped inside startSession instead of leaking local variables into
    // the managed pairing function.
    authState.creds.me = { id: jid, name: "~" };
    socket.ev.emit("creds.update", authState.creds);

    logWhatsappEvent(
      session,
      "info",
      "pairing_hello_accepted",
      "WhatsApp accepted pairing code registration",
      { hasPairingRef: true }
    );

    return pairingCode;
  } catch (error) {
    if (authState.creds.pairingCode === pairingCode) {
      authState.creds.pairingCode = undefined;
    }

    logWhatsappEvent(
      session,
      "warning",
      "pairing_hello_rejected",
      error.message,
      {
        statusCode:
          error?.output?.statusCode ||
          error?.statusCode ||
          null,
      }
    );

    throw error;
  }
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
      retryAt: null,
      notice: null,
    };

    managedPairingFlows.set(sessionId, flow);
    return flow;
  }

  const phoneChanged = flow.phoneDigits !== digits;
  const restartingAfterTerminalError = !flow.active;
  const rateLimitUntilMs = flow.rateLimitUntil
    ? new Date(flow.rateLimitUntil).getTime()
    : 0;

  if (!phoneChanged && rateLimitUntilMs > Date.now()) {
    const error = new Error(
      flow.lastError?.message || "rate-overlimit"
    );
    error.status = 429;
    error.details = { retryAt: flow.rateLimitUntil };
    throw error;
  }

  if (flow.rateLimitUntil && rateLimitUntilMs <= Date.now()) {
    flow.rateLimitUntil = null;
  }

  if (phoneChanged) {
    flow.rateLimitUntil = null;
  }

  if (phoneChanged || restartingAfterTerminalError) {
    clearManagedPairingTimers(flow);
    invalidateManagedPairingCode(flow);
    flow.requestInFlight = false;
    flow.attemptToken += 1;
    flow.failureCount = 0;
    flow.lastError = null;
    flow.lastFailureAt = null;
    flow.retryAt = null;
    flow.notice = null;
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
    void clearSupabaseAuthState(session.id).catch((error) => {
      console.warn(
        `[${session.id}] could not clear Supabase auth state:`,
        error.message
      );
    });
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

  // Baileys' 408/timedOut event is the source of truth for pairing-code
  // expiry. Do not infer validity from RidePicker's display countdown because
  // WhatsApp can retire the underlying refs earlier than our nominal timer.
  const naturalExpiry =
    statusCode === DisconnectReason.timedOut &&
    flow.published &&
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

  const rateLimited =
    statusCode === 429 ||
    /rate[-_\s]?overlimit|rate[-_\s]?limit/i.test(String(message || ""));

  if (rateLimited) {
    flow.rateLimitUntil = new Date(
      Date.now() + PAIRING_RATE_LIMIT_COOLDOWN_MS
    ).toISOString();
    flow.lastError = {
      code: "RATE_LIMITED",
      message: String(message || "rate-overlimit"),
      upstreamStatusCode: statusCode ?? null,
    };
  }

  const canAutoRetry =
    naturalExpiry ||
    (!rateLimited &&
      flow.failureCount <= MANAGED_PAIRING_MAX_AUTOMATIC_RETRIES);

  // Keep a frontend-safe notification in the same in-memory pairing flow.
  // Rate limiting is terminal for the current attempt because retrying it
  // immediately only extends the server-side throttle.
  if (rateLimited) {
    flow.notice = {
      id: `pairing_rate_limited_${flow.lastFailureAt}`,
      type: "error",
      title: flow.lastError.message,
      message: flow.lastError.message,
      failureCount: flow.failureCount,
      retrying: false,
      retryAt: flow.rateLimitUntil,
    };
  } else if (!naturalExpiry) {
    const firstFailure = flow.failureCount === 1;
    flow.notice = {
      id: `pairing_failure_${flow.lastFailureAt}`,
      type: canAutoRetry ? "warning" : "error",
      title: canAutoRetry
        ? firstFailure
          ? "Connection code needs another try"
          : "Still trying to create your connection code"
        : "Could not create a connection code",
      message: canAutoRetry
        ? firstFailure
          ? "The first attempt did not complete. RidePicker is retrying automatically."
          : "WhatsApp did not complete the last attempt. RidePicker is retrying automatically."
        : "Automatic retries stopped. Tap Generate connection code to try again.",
      failureCount: flow.failureCount,
      retrying: canAutoRetry,
      retryAt: null,
    };
  }

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
    ? 0
    : managedPairingRetryDelay(flow.failureCount);

  flow.retryAt = new Date(Date.now() + delay).toISOString();
  if (flow.notice?.retrying) {
    flow.notice.retryAt = flow.retryAt;
  }

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

  if (naturalExpiry) {
    // Start the replacement attempt in the same lifecycle turn. Socket setup
    // and WhatsApp's next QR challenge still take real network time, but there
    // is no artificial RidePicker delay anymore.
    flow.retryAt = null;
    void ensureManagedPairingAttempt(flow, {
      reason: 'expired_code_retry',
      forceNewCode: true,
    });
    return;
  }

  flow.retryTimer = setTimeout(() => {
    flow.retryTimer = null;
    flow.retryAt = null;

    if (!flow.active) return;

    void ensureManagedPairingAttempt(flow, {
      reason: 'auto_retry',
      forceNewCode: true,
    });
  }, delay);
}

async function ensureManagedPairingAttempt(
  flow,
  { reason = 'initial', forceNewCode = false } = {}
) {
  if (!flow?.active || flow.retryTimer) {
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

  if (flow.requestInFlight) {
    return null;
  }

  flow.requestInFlight = true;
  const attemptToken = ++flow.attemptToken;
  let session = null;

  try {
    session = sessions.get(flow.sessionId);

    if (!isCurrentSession(session) || !session.socket) {
      session = await startSession(flow.sessionId, {
        userId: flow.userId,
      });
    }

    if (
      !flow.active ||
      attemptToken !== flow.attemptToken ||
      !isCurrentSession(session)
    ) {
      return null;
    }

    if (session.registered) {
      stopManagedPairingFlow(flow.sessionId);
      return null;
    }

    const socket = session.socket;
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

    const candidateCode = await requestVerifiedPairingCode(
      session,
      socket,
      flow.phoneDigits
    );

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
    flow.retryAt = null;

    if (flow.failureCount > 0) {
      flow.notice = {
        id: `pairing_recovered_${flow.codeIssuedAt}`,
        type: "success",
        title: "Connection code ready",
        message:
          flow.failureCount === 1
            ? "The first attempt did not complete, but RidePicker created a fresh code automatically."
            : `RidePicker created a fresh code automatically after ${flow.failureCount} failed attempts.`,
        failureCount: flow.failureCount,
        retrying: false,
        retryAt: null,
      };
    }

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

  // Baileys attaches the WhatsApp stream-error reason node to Boom.data.
  // Keep only the small classification fields we need for diagnostics. Never
  // persist the full node because it may contain protocol/account metadata.
  const reasonNode =
    error?.data && typeof error.data === "object" ? error.data : null;
  const reasonTag =
    typeof reasonNode?.tag === "string" ? reasonNode.tag : null;
  const conflictType =
    reasonTag === "conflict" &&
    typeof reasonNode?.attrs?.type === "string"
      ? reasonNode.attrs.type
      : null;

  return {
    statusCode,
    message,
    reasonTag,
    conflictType,
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

  const { state, saveCreds } = await loadSupabaseAuthState(id);

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
    openedOnce: false,
    passkeyRequired: false,
    reconnectTimer: null,
    lastError: null,
    // This flag is set only by RidePicker immediately before socket.logout().
    // A remote/unsolicited 401 must never be allowed to impersonate that intent.
    logoutRequested: false,
    logoutRequestedAt: null,
    disposed: false,
  };

  sessions.set(id, session);

  // Use the current WhatsApp Web version for fresh device linking when it
  // can be resolved. Existing Baileys defaults remain the safe fallback.
  const waWebVersion = await resolveWaWebVersion();
  const socket = makeWASocket({
    auth: state,
    ...(waWebVersion ? { version: waWebVersion } : {}),
    logger: createBaileysRawLogger({
      userId,
      sessionId: id,
    }),
    markOnlineOnConnect: false,
    printQRInTerminal: false,
  });

  session.socket = socket;

  // WhatsApp can require an additional passkey/WebAuthn step for selected
  // accounts after pairing-code companion_finish. Baileys rc14 otherwise ACKs
  // that notification without completing it, leaving the user waiting until a
  // misleading 408. Detect the requirement immediately and discard partial
  // credentials instead of pretending the device is registered.
  socket.ws?.on?.("CB:notification", (node) => {
    const notificationType = node?.attrs?.type || null;

    if (
      ![
        "passkey_prologue_request",
        "crsc_continuation",
      ].includes(notificationType) ||
      !isCurrentSession(session)
    ) {
      return;
    }

    const hasRequestOptions = Boolean(
      Array.isArray(node?.content) &&
        node.content.some(
          (child) => child?.tag === "passkey_request_options"
        )
    );
    const pairingFlow = managedPairingFlows.get(id) || null;

    session.passkeyRequired = true;
    session.lastError = {
      code: "PASSKEY_REQUIRED",
      message:
        "WhatsApp requires an additional passkey verification step for this account.",
    };

    if (pairingFlow) {
      pairingFlow.lastError = session.lastError;
    }

    logWhatsappEvent(
      session,
      "warning",
      "pairing_passkey_required",
      "WhatsApp requires passkey verification during device linking",
      {
        notificationType,
        hasRequestOptions,
      }
    );

    stopManagedPairingFlow(id, {
      keepForError: true,
    });

    void persistSessionState(session, {
      status: "ERROR",
    });

    // Give Baileys' own notification listener time to ACK the stanza before
    // dropping the unusable partial auth state. No challenge contents are
    // logged or persisted by RidePicker.
    setTimeout(() => {
      if (!isCurrentSession(session) || !session.passkeyRequired) {
        return;
      }

      session.registered = false;
      dropSocketSession(session, {
        removeAuth: true,
        reason: "Passkey-required WhatsApp pairing cannot use partial auth",
      });
    }, 750);
  });

  socket.ev.on("creds.update", async () => {
    if (!isCurrentSession(session)) return;

    await saveCreds();

    const wasRegistered = session.registered;
    session.registered = Boolean(state?.creds?.registered);

    if (!wasRegistered && session.registered) {
      const pairingFlow = managedPairingFlows.get(id) || null;

      // The phone has consumed the pairing code. From this moment the code is
      // no longer useful to the user, even though the socket may still need a
      // 515 restart before reaching connection=open. Hide it immediately and
      // cancel the wall-clock rotation timer. If Baileys later reports 408,
      // that transport event is the authoritative expiry signal and a fresh
      // code is generated immediately.
      if (pairingFlow?.active) {
        if (pairingFlow.rotateTimer) {
          clearTimeout(pairingFlow.rotateTimer);
          pairingFlow.rotateTimer = null;
        }
        pairingFlow.published = false;
        pairingFlow.code = null;
        pairingFlow.codeRotatesAt = null;

        session.pairingCode = null;
        session.pairingCodeIssuedAt = null;

        logWhatsappEvent(
          session,
          "info",
          "pairing_code_consumed",
          "WhatsApp pairing code was consumed by the phone"
        );
      }

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
      unexpectedLogoutRecoveryAttempts.delete(id);
      session.logoutRequested = false;
      session.logoutRequestedAt = null;
      session.openedOnce = true;
      session.passkeyRequired = false;

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
      const { statusCode, message, reasonTag, conflictType } =
        disconnectDetails(lastDisconnect);

      console.warn(
        `[${id}] WhatsApp connection closed`,
        JSON.stringify({
          statusCode,
          message,
          reasonTag,
          conflictType,
          locallyRequestedLogout: Boolean(session.logoutRequested),
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
          reasonTag,
          conflictType,
          locallyRequestedLogout: Boolean(session.logoutRequested),
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

      // socket.logout() produces a 401-style close too. The explicit caller
      // owns the destructive transition and only finalizes LOGGED_OUT after
      // socket.logout() resolves. Returning here prevents a race that could
      // purge auth early and also prevents duplicate disconnect activity rows.
      if (session.logoutRequested) {
        clearReconnectTimer(session);
        unexpectedLogoutRecoveryAttempts.delete(id);
        session.lastError = null;

        console.log(`[${id}] expected close during requested WhatsApp logout`);
        logWhatsappEvent(
          session,
          "info",
          "whatsapp_logout_transport_closed",
          "WhatsApp transport closed during a requested logout",
          { statusCode, reasonTag, conflictType }
        );
        return;
      }

      const restartRequired =
        statusCode === DisconnectReason.restartRequired;
      const managedFlow = managedPairingFlows.get(id) || null;

      // companion_finish can set creds.registered=true before the newly linked
      // device has ever reached connection=open. A 408/401/428 at this point is
      // still a failed pairing, not a healthy registered session that should be
      // reconnected with half-completed credentials.
      const failedBeforeFirstOpen =
        managedFlow?.active &&
        !session.openedOnce &&
        [
          DisconnectReason.timedOut,
          DisconnectReason.loggedOut,
          DisconnectReason.connectionClosed,
        ].includes(statusCode);

      if (failedBeforeFirstOpen) {
        session.registered = false;

        await handleManagedPairingFailure(managedFlow, session, {
          statusCode,
          message,
          phase: "post_registration_pre_open",
        });

        return;
      }

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

      // An unsolicited 401 is NOT sufficient proof of a terminal logout.
      // Baileys v7 can surface transient conflict/device_removed stream errors
      // for a previously healthy companion. Preserve registered Supabase auth
      // and make a few bounded recovery attempts. If WhatsApp really removed
      // the device, stop in ERROR with auth preserved so only an explicit user
      // re-pair can replace it.
      if (statusCode === DisconnectReason.loggedOut) {
        const attempt =
          (unexpectedLogoutRecoveryAttempts.get(id) || 0) + 1;
        unexpectedLogoutRecoveryAttempts.set(id, attempt);

        if (attempt > UNEXPECTED_LOGOUT_RETRY_DELAYS_MS.length) {
          clearReconnectTimer(session);
          session.status = "ERROR";
          session.lastError = {
            code: "UNEXPECTED_401_RECOVERY_EXHAUSTED",
            message,
          };

          console.error(
            `[${id}] unexpected WhatsApp 401 recovery exhausted; preserving auth`
          );
          logWhatsappEvent(
            session,
            "error",
            "unexpected_401_recovery_exhausted",
            message,
            {
              statusCode,
              reasonTag,
              conflictType,
              attempts: attempt - 1,
              authPreserved: true,
            }
          );

          await persistSessionState(session, {
            status: "ERROR",
          });

          dropSocketSession(session, {
            removeAuth: false,
            reason: "Unexpected WhatsApp 401 recovery exhausted",
          });
          return;
        }

        const delayMs = UNEXPECTED_LOGOUT_RETRY_DELAYS_MS[attempt - 1];
        session.status = "RECONNECTING";

        console.warn(
          `[${id}] unexpected WhatsApp 401; preserving auth and retrying in ${delayMs}ms`
        );
        logWhatsappEvent(
          session,
          "warning",
          "unexpected_401_recovery_started",
          message,
          {
            statusCode,
            reasonTag,
            conflictType,
            attempt,
            delayMs,
            authPreserved: true,
          }
        );

        // Do not touch bot_mode, account identity, connected_at, or auth here.
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
              reason: "Recovering from unexpected WhatsApp 401",
            });

            try {
              await startSession(id, { userId });
            } catch (error) {
              console.error(`[${id}] unexpected 401 recovery failed:`, error);
              void writeSystemLog({
                userId,
                sessionId: id,
                level: "error",
                source: "whatsapp",
                event: "unexpected_401_recovery_start_failed",
                message: error.message,
                details: { authPreserved: true },
              });

              await repository.updateWhatsappSessionById(id, {
                status: "ERROR",
              });
            }
          }, delayMs);
        }

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

async function waitForManagedPairingOutcome(flow, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (managedPairingCodeIsVisible(flow)) {
      return "code_ready";
    }

    if (flow?.lastError) {
      return "error";
    }

    if (!flow?.active && !flow?.requestInFlight) {
      return "stopped";
    }

    await sleep(75);
  }

  return "timeout";
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

  // A terminal/exhausted previous attempt must start with completely fresh
  // Supabase auth state. A registered CONNECTED session is handled above and
  // is never deleted here.
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
        await clearSupabaseAuthState(dbSession.id);
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

  // Keep the POST open just long enough to know whether the first attempt
  // produced a real code or failed. Existing frontend error handling can then
  // show a toast immediately instead of leaving the user staring at a spinner.
  const firstOutcome = await waitForManagedPairingOutcome(flow);
  const latest = await repository.getWhatsappSessionByUser(userId);
  const normalized = normalizeManagedSession(
    latest,
    sessions.get(dbSession.id) || session
  );

  if (!normalized?.pairingCode && firstOutcome === "error" && flow.lastError) {
    const error = new Error(
      flow.lastError.message || "Unknown Baileys error"
    );
    error.status =
      flow.lastError.code === "RATE_LIMITED" ? 429 : 503;
    error.details = {
      code: flow.lastError.code || null,
      retrying: Boolean(flow.active && (flow.retryTimer || flow.requestInFlight)),
      retryAt: flow.notice?.retryAt || flow.retryAt || null,
    };
    throw error;
  }

  return normalized;
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
      await clearSupabaseAuthState(dbSession.id);
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

export async function disconnectSession(
  sessionId,
  { requestRemoteLogout = false } = {}
) {
  stopManagedPairingFlow(sessionId);

  const session = sessions.get(sessionId);

  if (session) {
    clearReconnectTimer(session);

    if (requestRemoteLogout) {
      if (!session.socket || typeof session.socket.logout !== "function") {
        const error = new Error(
          "Active WhatsApp socket is unavailable for logout."
        );
        error.status = 409;
        throw error;
      }

      session.logoutRequested = true;
      session.logoutRequestedAt = new Date().toISOString();

      try {
        // Match Baileys' own logout semantics exactly. Baileys sends
        // remove-companion-device with sendNode() and then ends the socket.
        // This confirms that the stanza was written to the transport, not that
        // WhatsApp returned an IQ acknowledgement. Do not claim remote ACK.
        await session.socket.logout();
      } catch (error) {
        session.logoutRequested = false;
        session.logoutRequestedAt = null;
        console.warn(`[${sessionId}] logout failed:`, error.message);
        if (!error.status) {
          error.status = 502;
        }
        throw error;
      }

      sessions.delete(sessionId);
      await clearSupabaseAuthState(sessionId);
      return;
    }

    try {
      if (session.socket) {
        session.logoutRequested = true;
        session.logoutRequestedAt = new Date().toISOString();
        await session.socket.logout();
      }
    } catch (error) {
      console.warn(`[${sessionId}] logout warning:`, error.message);
    }

    sessions.delete(sessionId);
  }

  await clearSupabaseAuthState(sessionId);
}

export async function disconnectManagedSession(userId) {
  const dbSession = await repository.getWhatsappSessionByUser(userId);

  if (!dbSession) {
    return null;
  }

  await disconnectSession(dbSession.id, {
    requestRemoteLogout: ["CONNECTED", "RECONNECTING"].includes(dbSession.status),
  });

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

  const dbStatus = dbSession?.status || null;
const terminalDbStatus = new Set(["LOGGED_OUT", "DISCONNECTED"]);

// Supabase is authoritative for terminal connection states. A stale
// in-memory Baileys session must never make a logged-out device look
// connected in the frontend.
let status =
  dbStatus && terminalDbStatus.has(dbStatus)
    ? dbStatus
    : memorySession?.status || dbStatus || "DISCONNECTED";

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
    pairingProgress: managedFlow
      ? {
          phase: pairingCode
            ? "code_ready"
            : managedFlow.active
            ? managedFlow.retryAt
              ? "retry_wait"
              : managedFlow.requestInFlight
              ? "generating"
              : "starting"
            : managedFlow.lastError
            ? "failed"
            : "idle",
          attempt: Math.max(1, (managedFlow.failureCount || 0) + 1),
          failureCount: managedFlow.failureCount || 0,
          retryAt: managedFlow.retryAt || null,
        }
      : null,
    pairingNotice: managedFlow?.notice || null,
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
    const terminal = ["LOGGED_OUT", "DISCONNECTED"].includes(
      dbSession.status
    );

    if (terminal) {
      if (await hasSupabaseAuthState(dbSession.id)) {
        await clearSupabaseAuthState(dbSession.id);
      }
      continue;
    }

    const hasAuthState = await hasSupabaseAuthState(dbSession.id);

    if (!hasAuthState) {
      void writeSystemLog({
        userId: dbSession.user_id,
        sessionId: dbSession.id,
        level: "warning",
        source: "whatsapp",
        event: "auth_state_missing",
        message: "WhatsApp auth state is missing from Supabase during restore",
        details: { previousStatus: dbSession.status },
      });

      await repository.updateWhatsappSessionById(dbSession.id, {
        status: "DISCONNECTED",
        bot_mode: "off",
      });

      await addSessionActivity(
        { id: dbSession.id, userId: dbSession.user_id },
        "WhatsApp disconnected",
        "Connection credentials were unavailable after backend restart."
      );
      continue;
    }

    // Pairing codes and their timers are process-local. Never revive a
    // half-finished pairing attempt after restart, even though its partial
    // cryptographic state is safely stored in Supabase.
    if (["STARTING", "QR", "ERROR"].includes(dbSession.status)) {
      await clearSupabaseAuthState(dbSession.id);

      await repository.updateWhatsappSessionById(dbSession.id, {
        status: "DISCONNECTED",
        bot_mode: "off",
      });

      void writeSystemLog({
        userId: dbSession.user_id,
        sessionId: dbSession.id,
        level: "info",
        source: "whatsapp",
        event: "pairing_reset_after_restart",
        message: "Incomplete WhatsApp pairing was reset after process restart",
        details: { previousStatus: dbSession.status },
      });

      await addSessionActivity(
        { id: dbSession.id, userId: dbSession.user_id },
        "WhatsApp disconnected",
        "Incomplete WhatsApp connection was reset after backend restart."
      );
      continue;
    }

    console.log(`Restoring managed session: ${dbSession.id}`);
    void writeSystemLog({
      userId: dbSession.user_id,
      sessionId: dbSession.id,
      level: "info",
      source: "whatsapp",
      event: "session_restore_started",
      message: "Restoring managed WhatsApp session from Supabase auth state",
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

export async function restoreSessions() {
  try {
    await restoreManagedSessions();
  } catch (error) {
    console.error("Managed session restore failed:", error.message);
  }
}
