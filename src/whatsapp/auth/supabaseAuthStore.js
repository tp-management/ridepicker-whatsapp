import {
  BufferJSON,
  initAuthCreds,
  proto,
} from "@whiskeysockets/baileys";

import { supabaseRequest } from "../../supabase.js";
import { writeSystemLog } from "../../systemLog.js";

export const SUPABASE_AUTH_TYPE = "baileys_supabase_v1";
const CREDS_KEY = "creds";

function serialize(value) {
  return JSON.stringify(value, BufferJSON.replacer);
}

function deserialize(value) {
  return JSON.parse(value, BufferJSON.reviver);
}

function signalKey(type, id) {
  return `${type}:${id}`;
}

function logAuthEvent(
  sessionId,
  level,
  event,
  message,
  details = {}
) {
  void writeSystemLog({
    sessionId,
    level,
    source: "whatsapp_auth",
    event,
    message,
    details,
  });
}

export function createSupabaseAuthStore({ request = supabaseRequest } = {}) {
  const mutationQueues = new Map();

  function enqueue(sessionId, operation) {
    const previous = mutationQueues.get(sessionId) || Promise.resolve();
    const run = previous.catch(() => {}).then(operation);
    const tracked = run.finally(() => {
      if (mutationQueues.get(sessionId) === tracked) {
        mutationQueues.delete(sessionId);
      }
    });
    mutationQueues.set(sessionId, tracked);
    return tracked;
  }

  async function waitForMutations(sessionId) {
    const pending = mutationQueues.get(sessionId);
    if (pending) {
      await pending;
    }
  }

  async function readRows(sessionId, authKeys = null) {
    await waitForMutations(sessionId);
    return (
      (await request("rpc/ridepicker_whatsapp_auth_read", {
        method: "POST",
        body: {
          p_session_id: sessionId,
          p_auth_type: SUPABASE_AUTH_TYPE,
          p_auth_keys: authKeys,
        },
      })) || []
    );
  }

  async function writeEntries(sessionId, entries) {
    if (!entries.length) return;

    try {
      await enqueue(sessionId, () =>
        request("rpc/ridepicker_whatsapp_auth_write", {
          method: "POST",
          body: {
            p_session_id: sessionId,
            p_auth_type: SUPABASE_AUTH_TYPE,
            p_entries: entries,
          },
        })
      );
    } catch (error) {
      logAuthEvent(
        sessionId,
        "error",
        "whatsapp_auth_write_failed",
        error.message,
        {
          entryCount: entries.length,
          containsCreds: entries.some((entry) => entry?.auth_key === CREDS_KEY),
          error,
          actionability: "actionable",
        }
      );
      throw error;
    }
  }

  async function clear(sessionId) {
    logAuthEvent(
      sessionId,
      "info",
      "whatsapp_auth_clear_started",
      "WhatsApp auth clear requested",
      { destructive: true, clearMode: "standard" }
    );

    try {
      await enqueue(sessionId, () =>
        request("rpc/ridepicker_whatsapp_auth_clear", {
          method: "POST",
          body: {
            p_session_id: sessionId,
            p_auth_type: SUPABASE_AUTH_TYPE,
          },
        })
      );

      logAuthEvent(
        sessionId,
        "info",
        "whatsapp_auth_clear_completed",
        "WhatsApp auth clear completed",
        { destructive: true, clearMode: "standard" }
      );
    } catch (error) {
      logAuthEvent(
        sessionId,
        "error",
        "whatsapp_auth_clear_failed",
        error.message,
        {
          destructive: true,
          clearMode: "standard",
          error,
          actionability: "actionable",
        }
      );
      throw error;
    }
  }

  async function clearForRelink(sessionId) {
    logAuthEvent(
      sessionId,
      "info",
      "whatsapp_auth_relink_clear_started",
      "Old WhatsApp auth clear started for explicit relink",
      {
        destructive: true,
        clearMode: "explicit_relink",
        actionability: "diagnostic",
      }
    );

    try {
      await enqueue(sessionId, () =>
        request("rpc/ridepicker_whatsapp_auth_prepare_relink", {
          method: "POST",
          body: {
            p_session_id: sessionId,
            p_auth_type: SUPABASE_AUTH_TYPE,
          },
        })
      );

      logAuthEvent(
        sessionId,
        "info",
        "whatsapp_auth_relink_clear_completed",
        "Old WhatsApp auth cleared for explicit relink",
        {
          destructive: true,
          clearMode: "explicit_relink",
          actionability: "diagnostic",
        }
      );
    } catch (error) {
      logAuthEvent(
        sessionId,
        "error",
        "whatsapp_auth_relink_clear_failed",
        error.message,
        {
          destructive: true,
          clearMode: "explicit_relink",
          error,
          actionability: "actionable",
        }
      );
      throw error;
    }
  }

  async function has(sessionId) {
    const rows = await readRows(sessionId, [CREDS_KEY]);
    const hasCreds = rows.some(
      (row) => row?.auth_key === CREDS_KEY && row?.payload
    );

    logAuthEvent(
      sessionId,
      "debug",
      "whatsapp_auth_presence_checked",
      "WhatsApp auth presence checked",
      {
        hasCreds,
        rowCount: rows.length,
      }
    );

    return hasCreds;
  }

  async function load(sessionId) {
    const rows = await readRows(sessionId, [CREDS_KEY]);
    const credsRow = rows.find((row) => row?.auth_key === CREDS_KEY);
    const hasStoredCreds = Boolean(credsRow?.payload);
    const creds = hasStoredCreds
      ? deserialize(credsRow.payload)
      : initAuthCreds();

    logAuthEvent(
      sessionId,
      "info",
      "whatsapp_auth_loaded",
      "WhatsApp auth state loaded",
      {
        hasStoredCreds,
        registered: Boolean(creds?.registered),
        rowCount: rows.length,
      }
    );

    return {
      state: {
        creds,
        keys: {
          get: async (type, ids) => {
            if (!Array.isArray(ids) || ids.length === 0) {
              return {};
            }

            const authKeys = ids.map((id) => signalKey(type, id));
            const keyRows = await readRows(sessionId, authKeys);
            const byAuthKey = new Map(
              keyRows.map((row) => [row.auth_key, row.payload])
            );
            const data = {};

            for (const id of ids) {
              const payload = byAuthKey.get(signalKey(type, id));
              let value = payload ? deserialize(payload) : null;

              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }

              data[id] = value;
            }

            return data;
          },

          set: async (data) => {
            const entries = [];

            for (const category of Object.keys(data || {})) {
              const values = data[category] || {};

              for (const id of Object.keys(values)) {
                const value = values[id];
                entries.push({
                  auth_key: signalKey(category, id),
                  payload:
                    value === null || value === undefined
                      ? null
                      : serialize(value),
                });
              }
            }

            await writeEntries(sessionId, entries);
          },
        },
      },

      saveCreds: async () => {
        await writeEntries(sessionId, [
          {
            auth_key: CREDS_KEY,
            payload: serialize(creds),
          },
        ]);
      },
    };
  }

  return {
    load,
    has,
    clear,
    clearForRelink,
    waitForMutations,
  };
}

const defaultStore = createSupabaseAuthStore();

export function loadSupabaseAuthState(sessionId) {
  return defaultStore.load(sessionId);
}

export function hasSupabaseAuthState(sessionId) {
  return defaultStore.has(sessionId);
}

export function clearSupabaseAuthState(sessionId) {
  return defaultStore.clear(sessionId);
}

export function clearSupabaseAuthStateForRelink(sessionId) {
  return defaultStore.clearForRelink(sessionId);
}
