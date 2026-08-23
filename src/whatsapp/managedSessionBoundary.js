import { repository } from "../repository.js";
import { writeSystemLog } from "../systemLog.js";
import {
  disconnectSession,
  getManagedSession,
  getSession,
  startSession,
  updatePolicyCache,
} from "../whatsapp.js";
import {
  hasSupabaseAuthState,
  loadSupabaseAuthState,
} from "./auth/supabaseAuthStore.js";

const TERMINAL_SESSION_STATUSES = new Set(["LOGGED_OUT", "DISCONNECTED"]);
const REMOTE_LOGOUT_READY_TIMEOUT_MS = 8_000;
const REMOTE_LOGOUT_POLL_MS = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpError(status, message, details = null) {
  const error = new Error(message);
  error.status = status;
  if (details) error.details = details;
  return error;
}

export function createManagedSessionBoundary({
  repository: repositoryAdapter,
  disconnectSession: disconnectSessionAdapter,
  getManagedSession: getManagedSessionAdapter,
  getSession: getSessionAdapter,
  startSession: startSessionAdapter,
  updatePolicyCache: updatePolicyCacheAdapter = () => {},
  hasSupabaseAuthState: hasSupabaseAuthStateAdapter,
  loadSupabaseAuthState: loadSupabaseAuthStateAdapter,
  writeSystemLog: writeSystemLogAdapter = async () => {},
  sleep: sleepAdapter = sleep,
  logoutReadyTimeoutMs = REMOTE_LOGOUT_READY_TIMEOUT_MS,
}) {
  async function inspectAuth(sessionId) {
    const exists = await hasSupabaseAuthStateAdapter(sessionId);

    if (!exists) {
      return { exists: false, registered: false };
    }

    const { state } = await loadSupabaseAuthStateAdapter(sessionId);

    return {
      exists: true,
      registered: Boolean(state?.creds?.registered),
    };
  }

  function stopRuntimeWithoutClearingAuth(runtimeSession, reason) {
    if (!runtimeSession) return;

    if (runtimeSession.reconnectTimer) {
      clearTimeout(runtimeSession.reconnectTimer);
      runtimeSession.reconnectTimer = null;
    }

    runtimeSession.disposed = true;

    const socket = runtimeSession.socket;
    runtimeSession.socket = null;

    if (socket) {
      try {
        socket.end?.(new Error(reason));
      } catch {
        // The transport may already be closed. Auth is intentionally preserved.
      }
    }
  }

  async function waitForRemoteLogoutReady(sessionId, fallbackSession) {
    const deadline = Date.now() + logoutReadyTimeoutMs;
    let runtimeSession = getSessionAdapter(sessionId) || fallbackSession || null;

    while (Date.now() < deadline) {
      runtimeSession = getSessionAdapter(sessionId) || runtimeSession;

      if (!runtimeSession) {
        return { runtimeSession: null, state: "missing_runtime" };
      }

      if (runtimeSession.status === "LOGGED_OUT") {
        return { runtimeSession, state: "already_logged_out" };
      }

      if (
        runtimeSession.status === "CONNECTED" ||
        (runtimeSession.registered && runtimeSession.openedOnce)
      ) {
        return { runtimeSession, state: "ready" };
      }

      if (!runtimeSession.socket) {
        return { runtimeSession, state: "missing_socket" };
      }

      await sleepAdapter(REMOTE_LOGOUT_POLL_MS);
    }

    return {
      runtimeSession: getSessionAdapter(sessionId) || runtimeSession,
      state: "timeout",
    };
  }

  async function updateLoggedOutState(dbSession) {
    const updated = await repositoryAdapter.updateWhatsappSessionById(
      dbSession.id,
      {
        status: "LOGGED_OUT",
        bot_mode: "off",
        whatsapp_phone: null,
        display_name: null,
        connected_at: null,
      }
    );

    if (updated) {
      updatePolicyCacheAdapter(updated);
    }

    return updated || {
      ...dbSession,
      status: "LOGGED_OUT",
      bot_mode: "off",
      whatsapp_phone: null,
      display_name: null,
      connected_at: null,
    };
  }

  async function cleanupKnownLoggedOut(dbSession) {
    const runtimeSession = getSessionAdapter(dbSession.id) || null;
    const hasAuthState = await hasSupabaseAuthStateAdapter(dbSession.id);

    if (!runtimeSession && !hasAuthState) {
      return dbSession;
    }

    // LOGGED_OUT means WhatsApp already told us the companion is gone, or a
    // successful native socket.logout() completed. It is therefore safe to
    // remove local runtime/auth residue without another remote logout attempt.
    await disconnectSessionAdapter(dbSession.id, {
      requestRemoteLogout: false,
    });

    return dbSession;
  }

  async function finalizeSuccessfulLogout(
    dbSession,
    userId,
    runtimeSession,
    { reason, recordActivity }
  ) {
    // Remote logout has completed before this point. Mark the durable state
    // terminal first, then clear runtime/auth. This ordering means the auth
    // store is never destroyed while WhatsApp may still consider the linked
    // device active.
    const updated = await updateLoggedOutState(dbSession);

    if (runtimeSession) {
      // socket.logout() already ended the transport. Avoid a duplicate logout
      // when disconnectSession() performs the local cleanup below.
      runtimeSession.socket = null;
    }

    await disconnectSessionAdapter(dbSession.id, {
      requestRemoteLogout: false,
    });

    if (recordActivity) {
      await repositoryAdapter.addActivity(userId, {
        type: "whatsapp",
        title: "WhatsApp disconnected",
        detail: "",
      });
    }

    await writeSystemLogAdapter({
      userId,
      sessionId: dbSession.id,
      level: "info",
      source: "whatsapp",
      event: "whatsapp_disconnected",
      message: "WhatsApp disconnected",
      details: { reason },
    });

    return updated;
  }

  async function remoteLogoutAndFinalize(
    dbSession,
    userId,
    { reason = "managed_disconnect", recordActivity = true } = {}
  ) {
    const auth = await inspectAuth(dbSession.id);
    let runtimeSession = getSessionAdapter(dbSession.id) || null;

    const hasUsableLinkedState = Boolean(
      runtimeSession?.registered ||
        runtimeSession?.socket?.user?.id ||
        auth.registered
    );

    if (!hasUsableLinkedState) {
      throw httpError(
        409,
        "RidePicker no longer has usable WhatsApp credentials to remove this linked device remotely. Remove the RidePicker device from WhatsApp Linked Devices on your phone.",
        { code: "REMOTE_LOGOUT_UNAVAILABLE" }
      );
    }

    let startedRuntimeForLogout = false;

    if (!runtimeSession?.socket) {
      if (!auth.registered) {
        throw httpError(
          409,
          "RidePicker no longer has usable WhatsApp credentials to remove this linked device remotely. Remove the RidePicker device from WhatsApp Linked Devices on your phone.",
          { code: "REMOTE_LOGOUT_UNAVAILABLE" }
        );
      }

      runtimeSession = await startSessionAdapter(dbSession.id, {
        userId,
      });
      startedRuntimeForLogout = true;
    }

    try {
      const readiness = await waitForRemoteLogoutReady(
        dbSession.id,
        runtimeSession
      );
      runtimeSession = readiness.runtimeSession || runtimeSession;

      if (readiness.state === "already_logged_out") {
        return finalizeSuccessfulLogout(dbSession, userId, runtimeSession, {
          reason: `${reason}_already_logged_out`,
          recordActivity,
        });
      }

      if (readiness.state !== "ready" || !runtimeSession?.socket?.logout) {
        throw httpError(
          503,
          "RidePicker could not reach WhatsApp to remove the linked device. Your saved WhatsApp credentials were preserved so the disconnect can be retried safely.",
          {
            code: "REMOTE_LOGOUT_NOT_READY",
            readiness: readiness.state,
          }
        );
      }

      await runtimeSession.socket.logout();

      return finalizeSuccessfulLogout(dbSession, userId, runtimeSession, {
        reason,
        recordActivity,
      });
    } catch (error) {
      // startSession() temporarily writes STARTING while it rehydrates a socket.
      // If remote logout fails, put the durable state back exactly where it was
      // and preserve Supabase auth for a later retry.
      if (startedRuntimeForLogout) {
        const restored = await repositoryAdapter.updateWhatsappSessionById(
          dbSession.id,
          {
            status: dbSession.status,
            bot_mode: dbSession.bot_mode || "off",
          }
        );
        if (restored) updatePolicyCacheAdapter(restored);
      }

      stopRuntimeWithoutClearingAuth(
        runtimeSession,
        "Remote WhatsApp logout did not complete"
      );

      await writeSystemLogAdapter({
        userId,
        sessionId: dbSession.id,
        level: "warning",
        source: "whatsapp",
        event: "whatsapp_remote_logout_failed",
        message: error.message,
        details: {
          reason,
          code: error?.details?.code || null,
          authPreserved: true,
        },
      });

      if (!error.status) error.status = 502;
      throw error;
    }
  }

  async function reconcileTerminalSession(userId) {
    const dbSession = await repositoryAdapter.getWhatsappSessionByUser(userId);

    if (!dbSession || !TERMINAL_SESSION_STATUSES.has(dbSession.status)) {
      return dbSession;
    }

    if (dbSession.status === "LOGGED_OUT") {
      return cleanupKnownLoggedOut(dbSession);
    }

    const runtimeSession = getSessionAdapter(dbSession.id) || null;
    const auth = await inspectAuth(dbSession.id);

    if (!runtimeSession && !auth.exists) {
      return dbSession;
    }

    const linkedStateMayStillExist = Boolean(
      runtimeSession?.registered ||
        runtimeSession?.socket?.user?.id ||
        auth.registered ||
        dbSession.connected_at
    );

    if (!linkedStateMayStillExist) {
      // Partial/unregistered pairing residue cannot represent a linked device.
      // It is safe to clear locally.
      await disconnectSessionAdapter(dbSession.id, {
        requestRemoteLogout: false,
      });
      return dbSession;
    }

    // DISCONNECTED plus registered credentials is a mixed state. Never erase
    // those credentials first. Rehydrate the session if needed, unlink the
    // companion through Baileys, and only then clear runtime/auth state.
    return remoteLogoutAndFinalize(dbSession, userId, {
      reason: "terminal_state_reconciliation",
      recordActivity: false,
    });
  }

  async function disconnectManagedSessionSafely(userId) {
    const dbSession = await repositoryAdapter.getWhatsappSessionByUser(userId);

    if (!dbSession) {
      return null;
    }

    if (dbSession.status === "LOGGED_OUT") {
      await cleanupKnownLoggedOut(dbSession);
      return getManagedSessionAdapter(userId);
    }

    const runtimeSession = getSessionAdapter(dbSession.id) || null;
    const auth = await inspectAuth(dbSession.id);
    const linkedStateMayStillExist = Boolean(
      runtimeSession?.registered ||
        runtimeSession?.socket?.user?.id ||
        auth.registered ||
        dbSession.connected_at ||
        ["CONNECTED", "RECONNECTING"].includes(dbSession.status)
    );

    if (!linkedStateMayStillExist) {
      const updated = await updateLoggedOutState(dbSession);
      await disconnectSessionAdapter(dbSession.id, {
        requestRemoteLogout: false,
      });
      await repositoryAdapter.addActivity(userId, {
        type: "whatsapp",
        title: "WhatsApp disconnected",
        detail: "",
      });
      return updated;
    }

    const updated = await remoteLogoutAndFinalize(dbSession, userId, {
      reason: "manual_disconnect",
      recordActivity: true,
    });

    return (await getManagedSessionAdapter(userId)) || updated;
  }

  return {
    reconcileTerminalSession,
    disconnectManagedSessionSafely,
  };
}

const boundary = createManagedSessionBoundary({
  repository,
  disconnectSession,
  getManagedSession,
  getSession,
  startSession,
  updatePolicyCache,
  hasSupabaseAuthState,
  loadSupabaseAuthState,
  writeSystemLog,
});

export const reconcileTerminalManagedSession = boundary.reconcileTerminalSession;
export const disconnectManagedSessionSafely =
  boundary.disconnectManagedSessionSafely;
