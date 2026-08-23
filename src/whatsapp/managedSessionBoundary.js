import { repository } from "../repository.js";
import {
  disconnectSession,
  getManagedSession,
  requestManagedPairingCode,
  startManagedSession,
} from "../whatsapp.js";

const TERMINAL_SESSION_STATUSES = new Set(["LOGGED_OUT", "DISCONNECTED"]);

export function createManagedSessionBoundary({
  repository: repositoryAdapter,
  disconnectSession: disconnectSessionAdapter,
  getManagedSession: getManagedSessionAdapter,
  requestManagedPairingCode: requestManagedPairingCodeAdapter,
  startManagedSession: startManagedSessionAdapter,
}) {
  async function reconcileTerminalSession(userId) {
    const dbSession = await repositoryAdapter.getWhatsappSessionByUser(userId);

    if (!dbSession || !TERMINAL_SESSION_STATUSES.has(dbSession.status)) {
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

  return {
    reconcileTerminalSession,

    async getReconciledManagedSession(userId) {
      await reconcileTerminalSession(userId);
      return getManagedSessionAdapter(userId);
    },

    async requestFreshManagedPairingCode(userId, phone = null) {
      await reconcileTerminalSession(userId);
      return requestManagedPairingCodeAdapter(userId, phone);
    },

    async startFreshManagedSession(userId, options = {}) {
      await reconcileTerminalSession(userId);
      return startManagedSessionAdapter(userId, options);
    },
  };
}

const boundary = createManagedSessionBoundary({
  repository,
  disconnectSession,
  getManagedSession,
  requestManagedPairingCode,
  startManagedSession,
});

export const reconcileTerminalManagedSession = boundary.reconcileTerminalSession;
export const getReconciledManagedSession = boundary.getReconciledManagedSession;
export const requestFreshManagedPairingCode = boundary.requestFreshManagedPairingCode;
export const startFreshManagedSession = boundary.startFreshManagedSession;
