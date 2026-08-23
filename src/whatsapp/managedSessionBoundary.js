import { repository } from "../repository.js";
import { disconnectSession, getSession } from "../whatsapp.js";
import { hasSupabaseAuthState } from "./auth/supabaseAuthStore.js";

const TERMINAL_SESSION_STATUSES = new Set(["LOGGED_OUT", "DISCONNECTED"]);

export function createManagedSessionBoundary({
  repository: repositoryAdapter,
  disconnectSession: disconnectSessionAdapter,
  getSession: getSessionAdapter,
  hasSupabaseAuthState: hasSupabaseAuthStateAdapter,
}) {
  async function reconcileTerminalSession(userId) {
    const dbSession = await repositoryAdapter.getWhatsappSessionByUser(userId);

    if (!dbSession || !TERMINAL_SESSION_STATUSES.has(dbSession.status)) {
      return dbSession;
    }

    const runtimeSession = getSessionAdapter(dbSession.id) || null;
    const hasAuthState = await hasSupabaseAuthStateAdapter(dbSession.id);

    // A clean terminal state is already fully reconciled. Avoid repeatedly
    // clearing Supabase auth on every frontend status poll.
    if (!runtimeSession && !hasAuthState) {
      return dbSession;
    }

    // Supabase is authoritative for terminal states. If it says the user is
    // disconnected, no stale Baileys runtime/auth state may survive behind
    // that frontend state. disconnectSession() stops pairing/reconnect timers,
    // attempts native logout when a socket still exists, removes the runtime
    // session and awaits Supabase auth cleanup before we continue.
    await disconnectSessionAdapter(dbSession.id, {
      requestRemoteLogout: false,
    });

    return dbSession;
  }

  return { reconcileTerminalSession };
}

const boundary = createManagedSessionBoundary({
  repository,
  disconnectSession,
  getSession,
  hasSupabaseAuthState,
});

export const reconcileTerminalManagedSession = boundary.reconcileTerminalSession;
