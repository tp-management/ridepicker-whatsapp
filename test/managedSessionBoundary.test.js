import test from "node:test";
import assert from "node:assert/strict";

import { createManagedSessionBoundary } from "../src/whatsapp/managedSessionBoundary.js";

function createHarness({
  status = "CONNECTED",
  connectedAt = "2026-08-23T14:09:02.368Z",
  hasRuntime = true,
  runtimeRegistered = true,
  runtimeStatus = "CONNECTED",
  hasAuth = true,
  authRegistered = true,
  logoutError = null,
  startError = null,
} = {}) {
  const calls = [];
  let authExists = hasAuth;
  let dbSession = {
    id: "session-user-1",
    user_id: "user-1",
    status,
    bot_mode: "assist",
    connected_at: connectedAt,
    whatsapp_phone: "+37061234567",
    display_name: "Test",
  };

  function makeRuntime() {
    const socket = {
      user: runtimeRegistered ? { id: "37061234567@s.whatsapp.net" } : null,
      async logout() {
        calls.push(["logout", runtime?.logoutRequested === true]);
        if (logoutError) throw logoutError;
      },
      end(error) {
        calls.push(["end", error?.message || null]);
      },
    };

    return {
      id: dbSession.id,
      registered: runtimeRegistered,
      openedOnce: runtimeStatus === "CONNECTED",
      status: runtimeStatus,
      socket,
      reconnectTimer: null,
      disposed: false,
    };
  }

  let runtime = hasRuntime ? makeRuntime() : null;

  const boundary = createManagedSessionBoundary({
    repository: {
      async getWhatsappSessionByUser(userId) {
        calls.push(["getDb", userId]);
        return dbSession;
      },
      async updateWhatsappSessionById(sessionId, patch) {
        calls.push(["updateDb", sessionId, patch]);
        dbSession = { ...dbSession, ...patch };
        return dbSession;
      },
      async addActivity(userId, entry) {
        calls.push(["activity", userId, entry]);
        return entry;
      },
    },
    async disconnectSession(sessionId, options) {
      calls.push(["disconnectLocal", sessionId, options]);
      runtime = null;
      authExists = false;
    },
    async getManagedSession(userId) {
      calls.push(["getManaged", userId]);
      return {
        sessionId: dbSession.id,
        status: dbSession.status === "LOGGED_OUT" ? "logged_out" : "connected",
      };
    },
    getSession(sessionId) {
      calls.push(["getRuntime", sessionId]);
      return runtime;
    },
    async startSession(sessionId, { userId }) {
      calls.push(["start", sessionId, userId]);
      if (startError) throw startError;
      runtime = makeRuntime();
      runtime.status = "CONNECTED";
      runtime.openedOnce = true;
      runtime.registered = true;
      return runtime;
    },
    updatePolicyCache(row) {
      calls.push(["policy", row.status]);
    },
    async hasSupabaseAuthState(sessionId) {
      calls.push(["hasAuth", sessionId]);
      return authExists;
    },
    async loadSupabaseAuthState(sessionId) {
      calls.push(["loadAuth", sessionId]);
      return { state: { creds: { registered: authRegistered } } };
    },
    async clearSupabaseAuthState(sessionId) {
      calls.push(["clearAuth", sessionId]);
      authExists = false;
    },
    async writeSystemLog(entry) {
      calls.push(["log", entry.event, entry.details]);
    },
    async sleep() {},
    logoutReadyTimeoutMs: 2,
  });

  return {
    boundary,
    calls,
    getDbSession: () => dbSession,
    getRuntime: () => runtime,
  };
}

function indexOfCall(calls, name) {
  return calls.findIndex((entry) => entry[0] === name);
}

test("DISCONNECTED + registered runtime repairs durable state and never logs out", async () => {
  const { boundary, calls, getDbSession } = createHarness({
    status: "DISCONNECTED",
    connectedAt: null,
    hasRuntime: true,
    runtimeRegistered: true,
    runtimeStatus: "CONNECTED",
    hasAuth: true,
    authRegistered: true,
  });

  await boundary.reconcileTerminalSession("user-1");

  assert.equal(getDbSession().status, "CONNECTED");
  assert.ok(getDbSession().connected_at);
  assert.equal(indexOfCall(calls, "logout"), -1);
  assert.equal(indexOfCall(calls, "clearAuth"), -1);
  assert.equal(indexOfCall(calls, "disconnectLocal"), -1);
});

test("DISCONNECTED + registered Supabase auth rehydrates instead of unlinking", async () => {
  const { boundary, calls } = createHarness({
    status: "DISCONNECTED",
    connectedAt: null,
    hasRuntime: false,
    hasAuth: true,
    authRegistered: true,
  });

  await boundary.reconcileTerminalSession("user-1");

  assert.ok(indexOfCall(calls, "start") >= 0);
  assert.equal(indexOfCall(calls, "logout"), -1);
  assert.equal(indexOfCall(calls, "clearAuth"), -1);
  assert.equal(indexOfCall(calls, "disconnectLocal"), -1);
});

test("recovery failure blocks downstream action and preserves registered auth", async () => {
  const { boundary, calls } = createHarness({
    status: "DISCONNECTED",
    connectedAt: null,
    hasRuntime: false,
    hasAuth: true,
    authRegistered: true,
    startError: new Error("cannot build socket"),
  });

  await assert.rejects(
    boundary.reconcileTerminalSession("user-1"),
    (error) => error?.status === 503 && error?.details?.code === "WHATSAPP_RECOVERY_FAILED"
  );

  assert.equal(indexOfCall(calls, "logout"), -1);
  assert.equal(indexOfCall(calls, "clearAuth"), -1);
  assert.equal(indexOfCall(calls, "disconnectLocal"), -1);
});

test("previously linked DISCONNECTED row with unusable creds fails closed", async () => {
  const { boundary, calls, getDbSession } = createHarness({
    status: "DISCONNECTED",
    connectedAt: "2026-08-23T14:09:02.368Z",
    hasRuntime: false,
    hasAuth: false,
    authRegistered: false,
  });

  await assert.rejects(
    boundary.reconcileTerminalSession("user-1"),
    (error) => error?.status === 409 && error?.details?.code === "WHATSAPP_CREDENTIALS_UNAVAILABLE"
  );

  assert.equal(getDbSession().status, "ERROR");
  assert.equal(getDbSession().bot_mode, "off");
  assert.equal(indexOfCall(calls, "logout"), -1);
  assert.equal(indexOfCall(calls, "clearAuth"), -1);
});

test("unregistered never-connected pairing residue is local-only cleanup", async () => {
  const { boundary, calls } = createHarness({
    status: "DISCONNECTED",
    connectedAt: null,
    hasRuntime: true,
    runtimeRegistered: false,
    runtimeStatus: "STARTING",
    hasAuth: true,
    authRegistered: false,
  });

  await boundary.reconcileTerminalSession("user-1");

  assert.equal(indexOfCall(calls, "logout"), -1);
  assert.ok(indexOfCall(calls, "end") >= 0);
  assert.ok(indexOfCall(calls, "disconnectLocal") >= 0);
});

test("LOGGED_OUT residue is cleaned locally without a second remote logout", async () => {
  const { boundary, calls } = createHarness({
    status: "LOGGED_OUT",
    connectedAt: null,
    hasRuntime: true,
    hasAuth: true,
    authRegistered: true,
  });

  await boundary.reconcileTerminalSession("user-1");

  assert.equal(indexOfCall(calls, "logout"), -1);
  assert.ok(indexOfCall(calls, "end") >= 0);
  assert.ok(indexOfCall(calls, "disconnectLocal") >= 0);
});

test("CONNECTED state is untouched by reconciliation", async () => {
  const { boundary, calls } = createHarness({ status: "CONNECTED" });

  await boundary.reconcileTerminalSession("user-1");

  assert.deepEqual(calls, [["getDb", "user-1"]]);
});

test("explicit disconnect performs native logout before LOGGED_OUT and cleanup", async () => {
  const { boundary, calls, getDbSession } = createHarness({ status: "CONNECTED" });

  await boundary.disconnectManagedSessionSafely("user-1");

  const logout = indexOfCall(calls, "logout");
  const update = calls.findIndex(
    (call) => call[0] === "updateDb" && call[2]?.status === "LOGGED_OUT"
  );
  const cleanup = indexOfCall(calls, "disconnectLocal");

  assert.ok(logout >= 0);
  assert.equal(calls[logout][1], true, "logout intent must be marked before socket.logout");
  assert.ok(update > logout);
  assert.ok(cleanup > update);
  assert.equal(getDbSession().status, "LOGGED_OUT");
  assert.equal(getDbSession().connected_at, null);
});

test("remote logout failure preserves auth and durable linked state", async () => {
  const failure = new Error("transport unavailable");
  const { boundary, calls, getDbSession, getRuntime } = createHarness({
    status: "CONNECTED",
    logoutError: failure,
  });

  await assert.rejects(
    boundary.disconnectManagedSessionSafely("user-1"),
    (error) => error?.status === 502 && error?.message === failure.message
  );

  assert.equal(getDbSession().status, "CONNECTED");
  assert.equal(getDbSession().connected_at, "2026-08-23T14:09:02.368Z");
  assert.equal(indexOfCall(calls, "clearAuth"), -1);
  assert.equal(indexOfCall(calls, "disconnectLocal"), -1);
  assert.equal(getRuntime()?.socket, null);
  assert.ok(
    calls.some(
      (call) => call[0] === "log" && call[1] === "whatsapp_remote_logout_failed" && call[2]?.authPreserved
    )
  );
});

test("registered Supabase auth can rehydrate only for an explicit remote disconnect", async () => {
  const { boundary, calls, getDbSession } = createHarness({
    status: "DISCONNECTED",
    connectedAt: null,
    hasRuntime: false,
    hasAuth: true,
    authRegistered: true,
  });

  await boundary.disconnectManagedSessionSafely("user-1");

  assert.ok(indexOfCall(calls, "start") >= 0);
  assert.ok(indexOfCall(calls, "logout") > indexOfCall(calls, "start"));
  assert.equal(getDbSession().status, "LOGGED_OUT");
});

test("missing credentials cannot be disguised as a successful explicit disconnect", async () => {
  const { boundary, calls, getDbSession } = createHarness({
    status: "CONNECTED",
    hasRuntime: false,
    hasAuth: false,
  });

  await assert.rejects(
    boundary.disconnectManagedSessionSafely("user-1"),
    (error) => error?.status === 409 && error?.details?.code === "REMOTE_LOGOUT_UNAVAILABLE"
  );

  assert.equal(getDbSession().status, "CONNECTED");
  assert.equal(indexOfCall(calls, "clearAuth"), -1);
});
