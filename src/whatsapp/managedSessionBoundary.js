import { repository } from "../repository.js";
import { writeSystemLog } from "../systemLog.js";
import {
  getManagedSession,
  getSession,
  startSession,
  updatePolicyCache,
} from "../whatsapp.js";
import {
  clearSupabaseAuthState,
  hasSupabaseAuthState,
  loadSupabaseAuthState,
} from "./auth/supabaseAuthStore.js";

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
  getManagedSession: getManagedSessionAdapter,
  getSession: getSessionAdapter,
  startSession: startSessionAdapter,
  updatePolicyCache: updatePolicyCacheAdapter = () => {},
  hasSupabaseAuthState: hasSupabaseAuthStateAdapter,
  loadSupabaseAuthState: loadSupabaseAuthStateAdapter,
  clearSupabaseAuthState: clearSupabaseAuthStateAdapter,
  writeSystemLog: writeSystemLogAdapter = async () => {},
  sleep: sleepAdapter = sleep,
  logoutReadyTimeoutMs = REMOTE_LOGOUT_READY_TIMEOUT_MS,
}) {
  async function bestEffortLog(entry) {
    try {
      await writeSystemLogAdapter(entry);
    } catch (error) {
      console.warn(
        `[${entry?.sessionId || "whatsapp"}] system log write failed:`,
        error.message
      );
    }
  }

  async function bestEffortActivity(userId, entry) {
    try {
      await repositoryAdapter.addActivity(userId, entry);
    } catch (error) {
      console.warn(
        `[${entry?.type || "whatsapp"}] activity write failed:`,
        error.message
      );
    }
  }

  async function inspectAuth(sessionId) {
    const exists = await hasSupabaseAuthStateAdapter(sessionId);
    if (!exists) return { exists: false, registered: false };

    const { state } = await loadSupabaseAuthStateAdapter(sessionId);
    return {
      exists: true,
      registered: Boolean(state?.creds?.registered),
    };
  }

  function stopRuntimeLocally(runtimeSession, reason) {
    if (!runtimeSession) return;

    if (runtimeSession.reconnectTimer) {
      clearTimeout(runtimeSession.reconnectTimer);
      runtimeSession.reconnectTimer = null;
    }

    runtimeSession.disposed = true;
    const socket = runtimeSession.socket;
    runtimeSession.socket = null;

    try {
      socket?.end?.(new Error(reason));
    } catch {
      // Local transport cleanup must never turn into a remote logout attempt.
    }
  }

  async function updateDb(dbSession, patch) {
    const updated = await repositoryAdapter.updateWhatsappSessionById(
      dbSession.id,
      patch
    );
    if (updated) updatePolicyCacheAdapter(updated);
    return updated || { ...dbSession, ...patch };
  }

  async function cleanupKnownLoggedOut(dbSession) {
    const runtimeSession = getSessionAdapter(dbSession.id) || null;
    if (runtimeSession) {
      stopRuntimeLocally(runtimeSession, "Cleaning already logged-out session");
    }

    if (await hasSupabaseAuthStateAdapter(dbSession.id)) {
      await clearSupabaseAuthStateAdapter(dbSession.id);
    }

    return dbSession;
  }

  async function cleanupUnregisteredResidue(dbSession, runtimeSession) {
    if (runtimeSession) {
      stopRuntimeLocally(runtimeSession, "Cleaning unregistered pairing residue");
    }
    await clearSupabaseAuthStateAdapter(dbSession.id);
    return dbSession;
  }

  async function waitForRemoteLogoutReady(sessionId, fallbackSession) {
    const deadline = Date.now() + logoutReadyTimeoutMs;
    let runtimeSession = getSessionAdapter(sessionId) || fallbackSession || null;

    while (Date.now() < deadline) {
      runtimeSession = getSessionAdapter(sessionId) || runtimeSession;
      if (!runtimeSession) return { runtimeSession: null, state: "missing_runtime" };
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
    return updateDb(dbSession, {
      status: "LOGGED_OUT",
      bot_mode: "off",
      whatsapp_phone: null,
      display_name: null,
      connected_at: null,
    });
  }

  async function finalizeSuccessfulLogout(
    dbSession,
    userId,
    runtimeSession,
    { reason, recordActivity }
  ) {
    // Explicit remote logout succeeded. Only now is it safe to mark LOGGED_OUT,
    // which also activates the database auth-purge guard.
    const updated = await updateLoggedOutState(dbSession);
    stopRuntimeLocally(runtimeSession, "Remote WhatsApp logout completed");
    await clearSupabaseAuthStateAdapter(dbSession.id);

    if (recordActivity) {
      await bestEffortActivity(userId, {
        type: "whatsapp",
        title: "WhatsApp disconnected",
        detail: "",
      });
    }

    await bestEffortLog({
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
      runtimeSession = await startSessionAdapter(dbSession.id, { userId });
      startedRuntimeForLogout = true;
    }

    try {
      const readiness = await waitForRemoteLogoutReady(dbSession.id, runtimeSession);
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
          { code: "REMOTE_LOGOUT_NOT_READY", readiness: readiness.state }
        );
      }

      await runtimeSession.socket.logout();
      return finalizeSuccessfulLogout(dbSession, userId, runtimeSession, {
        reason,
        recordActivity,
      });
    } catch (error) {
      if (startedRuntimeForLogout) {
        await updateDb(dbSession, {
          status: dbSession.status,
          bot_mode: dbSession.bot_mode || "off",
        });
      }

      stopRuntimeLocally(runtimeSession, "Remote WhatsApp logout did not complete");
      await bestEffortLog({
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
    if (!dbSession) return null;

    // A GET or ordinary user-facing WhatsApp action must never unlink a device.
    // Only confirmed LOGGED_OUT may be cleaned without talking to WhatsApp.
    if (dbSession.status === "LOGGED_OUT") {
      return cleanupKnownLoggedOut(dbSession);
    }

    if (dbSession.status !== "DISCONNECTED") {
      return dbSession;
    }

    const runtimeSession = getSessionAdapter(dbSession.id) || null;
    const auth = await inspectAuth(dbSession.id);

    // If the runtime is already healthy, repair the stale durable row instead
    // of trusting DISCONNECTED over a live registered socket.
    if (
      runtimeSession?.registered &&
      (runtimeSession.status === "CONNECTED" || runtimeSession.openedOnce)
    ) {
      return updateDb(dbSession, {
        status: "CONNECTED",
        connected_at: dbSession.connected_at || new Date().toISOString(),
      });
    }

    // Registered auth is recoverable linked-device state. Rehydrate it. Never
    // call logout and never clear it merely because the DB snapshot says
    // DISCONNECTED.
    if (runtimeSession?.registered || auth.registered) {
      if (runtimeSession?.socket) {
        return updateDb(dbSession, { status: "RECONNECTING" });
      }

      try {
        await updateDb(dbSession, { status: "RECONNECTING" });
        await startSessionAdapter(dbSession.id, { userId });
        return repositoryAdapter.getWhatsappSessionByUser(userId);
      } catch (error) {
        await bestEffortLog({
          userId,
          sessionId: dbSession.id,
          level: "error",
          source: "whatsapp",
          event: "terminal_state_recovery_failed",
          message: error.message,
          details: { authPreserved: true, previousStatus: dbSession.status },
        });
        throw httpError(
          503,
          "RidePicker could not restore the saved WhatsApp session. Credentials were preserved and no device was disconnected.",
          { code: "WHATSAPP_RECOVERY_FAILED" }
        );
      }
    }

    // connected_at is durable evidence that this row previously represented a
    // linked device. Missing/unregistered auth is a corruption/recovery case,
    // not permission to erase state or start a new pairing behind its back.
    if (dbSession.connected_at) {
      await updateDb(dbSession, { status: "ERROR", bot_mode: "off" });
      throw httpError(
        409,
        "RidePicker cannot safely recover this previously linked WhatsApp session because usable credentials are unavailable. No device was disconnected.",
        { code: "WHATSAPP_CREDENTIALS_UNAVAILABLE" }
      );
    }

    // Never-connected, unregistered pairing residue has no remote companion to
    // unlink. Local cleanup is safe and lets a fresh user-requested pair begin.
    if (runtimeSession || auth.exists) {
      await cleanupUnregisteredResidue(dbSession, runtimeSession);
    }

    return dbSession;
  }

  async function disconnectManagedSessionSafely(userId) {
    const dbSession = await repositoryAdapter.getWhatsappSessionByUser(userId);
    if (!dbSession) return null;

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
      await cleanupUnregisteredResidue(dbSession, runtimeSession);
      await bestEffortActivity(userId, {
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
  getManagedSession,
  getSession,
  startSession,
  updatePolicyCache,
  hasSupabaseAuthState,
  loadSupabaseAuthState,
  clearSupabaseAuthState,
  writeSystemLog,
});

export const reconcileTerminalManagedSession = boundary.reconcileTerminalSession;
export const disconnectManagedSessionSafely = boundary.disconnectManagedSessionSafely;
