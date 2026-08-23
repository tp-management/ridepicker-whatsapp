import { repository } from "../repository.js";
import { writeSystemLog } from "../systemLog.js";
import {
  getSession,
  getSessions,
  startSession,
  updatePolicyCache,
} from "../whatsapp.js";
import {
  clearSupabaseAuthState,
  hasSupabaseAuthState,
  loadSupabaseAuthState,
} from "./auth/supabaseAuthStore.js";

const LINKED_DURABLE_STATUSES = new Set(["CONNECTED", "RECONNECTING"]);
const PAIRING_DURABLE_STATUSES = new Set(["STARTING", "QR", "ERROR"]);

function asErrorMessage(error) {
  return error?.message || String(error || "Unknown error");
}

export function createRestartRecovery({
  repository: repositoryAdapter,
  startSession: startSessionAdapter,
  hasSupabaseAuthState: hasSupabaseAuthStateAdapter,
  loadSupabaseAuthState: loadSupabaseAuthStateAdapter,
  clearSupabaseAuthState: clearSupabaseAuthStateAdapter,
  updatePolicyCache: updatePolicyCacheAdapter = () => {},
  writeSystemLog: writeSystemLogAdapter = async () => {},
} = {}) {
  async function log(entry) {
    try {
      await writeSystemLogAdapter(entry);
    } catch (error) {
      console.warn(
        `[${entry?.sessionId || "whatsapp"}] recovery log failed:`,
        asErrorMessage(error)
      );
    }
  }

  async function updateSession(dbSession, patch) {
    const updated = await repositoryAdapter.updateWhatsappSessionById(
      dbSession.id,
      patch
    );
    if (updated) updatePolicyCacheAdapter(updated);
    return updated || { ...dbSession, ...patch };
  }

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

  async function recoverOne(dbSession) {
    const userId = dbSession.user_id;

    // LOGGED_OUT is the only durable state that proves the companion is gone.
    // Residual local auth is safe to purge here and must never be rehydrated.
    if (dbSession.status === "LOGGED_OUT") {
      await clearSupabaseAuthStateAdapter(dbSession.id);
      return { sessionId: dbSession.id, action: "logged_out_cleanup" };
    }

    const auth = await inspectAuth(dbSession.id);
    const linkedDurableProof = Boolean(
      dbSession.connected_at || LINKED_DURABLE_STATUSES.has(dbSession.status)
    );

    // Registered Baileys credentials are stronger evidence than a transient DB
    // lifecycle value. STARTING/QR/ERROR/DISCONNECTED can all be snapshots left
    // behind when a process dies between durable writes. Never delete registered
    // auth during process startup. Rehydrate it and let WhatsApp itself decide
    // whether the linked device is still valid.
    if (auth.registered) {
      await log({
        userId,
        sessionId: dbSession.id,
        level: "info",
        source: "whatsapp",
        event: "session_restore_started",
        message: "Restoring registered WhatsApp session from Supabase auth state",
        details: { previousStatus: dbSession.status },
      });

      try {
        await startSessionAdapter(dbSession.id, { userId });
        return { sessionId: dbSession.id, action: "restored_registered" };
      } catch (error) {
        await updateSession(dbSession, {
          status: "RECONNECTING",
        });
        await log({
          userId,
          sessionId: dbSession.id,
          level: "error",
          source: "whatsapp",
          event: "session_restore_failed",
          message: asErrorMessage(error),
          details: {
            previousStatus: dbSession.status,
            authPreserved: true,
          },
        });
        return {
          sessionId: dbSession.id,
          action: "restore_failed_auth_preserved",
          error,
        };
      }
    }

    // If the durable row says this session had been linked but credentials are
    // missing or unexpectedly unregistered, destroying more state cannot make
    // the situation safer. Fail closed, preserve any residue, and require an
    // explicit recovery/disconnect decision later.
    if (linkedDurableProof) {
      await updateSession(dbSession, {
        status: "ERROR",
        bot_mode: "off",
      });
      await log({
        userId,
        sessionId: dbSession.id,
        level: "error",
        source: "whatsapp",
        event: "session_restore_credentials_unusable",
        message: auth.exists
          ? "Stored WhatsApp credentials are not registered during restart recovery"
          : "WhatsApp credentials are missing during restart recovery",
        details: {
          previousStatus: dbSession.status,
          authExists: auth.exists,
          authRegistered: auth.registered,
          authPreserved: true,
        },
      });
      return {
        sessionId: dbSession.id,
        action: "unusable_linked_auth_preserved",
      };
    }

    // Process-local pairing codes/timers cannot survive a restart. Only an
    // unregistered, never-connected pairing attempt is safe to reset locally.
    // The database guard permits this clear because connected_at is null.
    if (
      auth.exists ||
      PAIRING_DURABLE_STATUSES.has(dbSession.status) ||
      dbSession.status === "DISCONNECTED"
    ) {
      await clearSupabaseAuthStateAdapter(dbSession.id);

      if (dbSession.status !== "DISCONNECTED" || dbSession.bot_mode !== "off") {
        await updateSession(dbSession, {
          status: "DISCONNECTED",
          bot_mode: "off",
        });
      }

      if (auth.exists || PAIRING_DURABLE_STATUSES.has(dbSession.status)) {
        await log({
          userId,
          sessionId: dbSession.id,
          level: "info",
          source: "whatsapp",
          event: "unregistered_pairing_reset_after_restart",
          message: "Unregistered WhatsApp pairing state reset after process restart",
          details: {
            previousStatus: dbSession.status,
            registered: false,
          },
        });
      }

      return { sessionId: dbSession.id, action: "unregistered_pairing_reset" };
    }

    return { sessionId: dbSession.id, action: "unchanged" };
  }

  async function recoverAll() {
    const dbSessions = await repositoryAdapter.listWhatsappSessions();
    const results = [];
    const blockingFailures = [];

    // Examine every session even if one fails, so logs contain a complete
    // picture. Any unresolved infrastructure/recovery failure still keeps the
    // new container unready, allowing Railway to retain the previous healthy
    // deployment instead of routing traffic to a half-restored process.
    for (const dbSession of dbSessions || []) {
      try {
        const result = await recoverOne(dbSession);
        results.push(result);
        if (result.action === "restore_failed_auth_preserved") {
          blockingFailures.push(result);
        }
      } catch (error) {
        await log({
          userId: dbSession?.user_id || null,
          sessionId: dbSession?.id || null,
          level: "error",
          source: "whatsapp",
          event: "session_recovery_unexpected_failure",
          message: asErrorMessage(error),
          details: { previousStatus: dbSession?.status || null },
        });
        const result = {
          sessionId: dbSession?.id || null,
          action: "unexpected_failure",
          error,
        };
        results.push(result);
        blockingFailures.push(result);
      }
    }

    if (blockingFailures.length) {
      const error = new Error(
        `WhatsApp restart recovery has ${blockingFailures.length} unresolved failure(s)`
      );
      error.results = results;
      throw error;
    }

    return results;
  }

  return { recoverOne, recoverAll };
}

const defaultRecovery = createRestartRecovery({
  repository,
  startSession,
  hasSupabaseAuthState,
  loadSupabaseAuthState,
  clearSupabaseAuthState,
  updatePolicyCache,
  writeSystemLog,
});

export const recoverManagedSessions = defaultRecovery.recoverAll;

export async function shutdownManagedSessions() {
  // Process shutdown is NOT a user logout. Close transports locally, suppress
  // lifecycle callbacks/reconnect timers, and leave Supabase auth + durable
  // connection state untouched for the next process to restore.
  for (const item of getSessions()) {
    const session = getSession(item.id);
    if (!session) continue;

    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }

    session.disposed = true;
    const socket = session.socket;
    session.socket = null;

    try {
      socket?.end?.(new Error("RidePicker process shutting down"));
    } catch {
      // Transport may already be closed. Never escalate shutdown into logout.
    }
  }
}
