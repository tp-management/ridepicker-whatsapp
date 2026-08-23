import test from "node:test";
import assert from "node:assert/strict";

import { createSupabaseAuthStore } from "../src/whatsapp/auth/supabaseAuthStore.js";

function createFakeRpc() {
  const rows = new Map();
  const keyFor = (sessionId, authType, authKey) =>
    `${sessionId}|${authType}|${authKey}`;

  async function request(path, { body } = {}) {
    if (path === "rpc/ridepicker_whatsapp_auth_read") {
      const requested = body.p_auth_keys;
      const prefix = `${body.p_session_id}|${body.p_auth_type}|`;
      const result = [];

      for (const [key, payload] of rows.entries()) {
        if (!key.startsWith(prefix)) continue;
        const authKey = key.slice(prefix.length);
        if (requested && !requested.includes(authKey)) continue;
        result.push({ auth_key: authKey, payload });
      }

      return result;
    }

    if (path === "rpc/ridepicker_whatsapp_auth_write") {
      for (const entry of body.p_entries || []) {
        const key = keyFor(
          body.p_session_id,
          body.p_auth_type,
          entry.auth_key
        );
        if (entry.payload === null || entry.payload === undefined) {
          rows.delete(key);
        } else {
          rows.set(key, entry.payload);
        }
      }
      return null;
    }

    if (path === "rpc/ridepicker_whatsapp_auth_clear") {
      const prefix = `${body.p_session_id}|${body.p_auth_type}|`;
      for (const key of [...rows.keys()]) {
        if (key.startsWith(prefix)) rows.delete(key);
      }
      return null;
    }

    throw new Error(`Unexpected RPC path: ${path}`);
  }

  return { request, rows };
}

test("fresh Supabase auth state starts unregistered and persists creds across reload", async () => {
  const rpc = createFakeRpc();
  const store = createSupabaseAuthStore({ request: rpc.request });
  const sessionId = "session-creds";

  const first = await store.load(sessionId);
  assert.equal(first.state.creds.registered, false);
  assert.equal(await store.has(sessionId), false);

  first.state.creds.registered = true;
  first.state.creds.me = {
    id: "37061234567@s.whatsapp.net",
    name: "RidePicker",
  };
  await first.saveCreds();

  assert.equal(await store.has(sessionId), true);

  const restored = await store.load(sessionId);
  assert.equal(restored.state.creds.registered, true);
  assert.equal(restored.state.creds.me.id, "37061234567@s.whatsapp.net");
});

test("Signal keys round-trip through Supabase and null deletes a key", async () => {
  const rpc = createFakeRpc();
  const store = createSupabaseAuthStore({ request: rpc.request });
  const { state } = await store.load("session-keys");

  await state.keys.set({
    "pre-key": {
      "1": {
        public: Buffer.from([1, 2, 3]),
        private: Buffer.from([4, 5, 6]),
      },
    },
  });

  const loaded = await state.keys.get("pre-key", ["1", "missing"]);
  assert.deepEqual(Buffer.from(loaded["1"].public), Buffer.from([1, 2, 3]));
  assert.deepEqual(Buffer.from(loaded["1"].private), Buffer.from([4, 5, 6]));
  assert.equal(loaded.missing, null);

  await state.keys.set({ "pre-key": { "1": null } });
  const deleted = await state.keys.get("pre-key", ["1"]);
  assert.equal(deleted["1"], null);
});

test("app-state sync keys are reconstructed with Baileys protobuf semantics", async () => {
  const rpc = createFakeRpc();
  const store = createSupabaseAuthStore({ request: rpc.request });
  const { state } = await store.load("session-app-state");

  await state.keys.set({
    "app-state-sync-key": {
      "sync-1": {
        keyData: Buffer.from([9, 8, 7]),
      },
    },
  });

  const loaded = await state.keys.get("app-state-sync-key", ["sync-1"]);
  assert.ok(loaded["sync-1"]);
  assert.deepEqual(
    Buffer.from(loaded["sync-1"].keyData),
    Buffer.from([9, 8, 7])
  );
});

test("clear removes credentials and Signal keys for the session", async () => {
  const rpc = createFakeRpc();
  const store = createSupabaseAuthStore({ request: rpc.request });
  const sessionId = "session-clear";
  const auth = await store.load(sessionId);

  auth.state.creds.registered = true;
  await auth.saveCreds();
  await auth.state.keys.set({
    session: {
      abc: { value: Buffer.from("secret") },
    },
  });

  assert.equal(await store.has(sessionId), true);
  await store.clear(sessionId);
  assert.equal(await store.has(sessionId), false);

  const reloaded = await store.load(sessionId);
  assert.equal(reloaded.state.creds.registered, false);
  assert.equal((await reloaded.state.keys.get("session", ["abc"])).abc, null);
});

test("queued clear completes before a following reload reads auth state", async () => {
  const rpc = createFakeRpc();
  const store = createSupabaseAuthStore({ request: rpc.request });
  const sessionId = "session-ordering";
  const auth = await store.load(sessionId);

  auth.state.creds.registered = true;
  await auth.saveCreds();

  const clearPromise = store.clear(sessionId);
  const restoredPromise = store.load(sessionId);
  const [, restored] = await Promise.all([clearPromise, restoredPromise]);

  assert.equal(restored.state.creds.registered, false);
});
