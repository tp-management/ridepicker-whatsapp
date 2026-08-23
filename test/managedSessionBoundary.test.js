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
} = {}) {
  const calls = [];
  let dbSession = {
    id: "session-user-1",
    user_id: "user-1",
    status,
    bot_mode: "off",
    connected_at: connectedAt,
    whatsapp_phone: "+37061234567",
    display_name: "Test",
  };

  function makeRuntime() {
    const socket = {
      user: runtimeRegistered
        ? { id: "37061234567@s.whatsapp.net" }
        : null,
      async logout() {
        calls.push(["logout"]);
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
      calls.push(["disconnect", sessionId, options]);
      runtime = null;
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
      return hasAuth;
    },
    async loadSupabaseAuthState(sessionId) {
      calls.push(["loadAuth", sessionId]);
      return {
        state: {
          creds: { registered: authRegistered },
        },
      };
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

test("DISCONNECTED registered residue remote-unlinks before durable/auth cleanup", async () => {
  const { boundary, calls, getDbSession } = createHarness({
    status: "DISCONNECTED",
    hasRuntime: true,
    runtimeRegistered: true,
    hasAuth: true,
    authRegistered: true,
  });

  await boundary.reconcileTerminalSession("user-1");

  const logoutIndex = indexOfCall(calls, "logout");
  const updateIndex = indexOfCall(calls, "updateDb");
  const disconnectIndex = indexOfCall(calls, "disconnect");

  assert.ok(logoutIndex >= 0, "expected native socket.logout");
  assert.ok(updateIndex > logoutIndex, "DB must become LOGGED_OUT after remote logout");
  assert.ok(
    disconnectIndex > updateIndex,
    "runtime/auth cleanup must happen only after durable LOGGED_OUT"
  );
  assert.equal(getDbSession().status, "LOGGED_OUT");
  assert.equal(getDbSession().connected_at, null);
});

test("remote logout failure preserves auth and never claims local logout", async () => {
  const failure = new Error("transport unavailable");
  const { boundary, calls, getDbSession, getRuntime } = createHarness({
    status: "CONNECTED",
    logoutError: failure,
  });

  await assert.rejects(
    boundary.disconnectManagedSessionSafely("user-1"),
    (error) => error?.status === 502 && error?.message === failure.message
  );

  assert.equal(indexOfCall(calls, "disconnect"), -1);
  assert.equal(getDbSession().status, "CONNECTED");
  assert.equal(getDbSession().connected_at, "2026-08-23T14:09:02.368Z");
  assert.equal(getRuntime()?.socket, null);
  assert.ok(indexOfCall(calls, "end") > indexOfCall(calls, "logout"));
  assert.ok(
    calls.some(
      (entry) =>
        entry[0] === "log" &&
        entry[1] === "whatsapp_remote_logout_failed" &&
        entry[2]?.authPreserved === true
    )
  );
});

test("registered Supabase auth can rehydrate a socket before remote unlink", async () => {
  const { boundary, calls, getDbSession } = createHarness({
    status: "DISCONNECTED",
    hasRuntime: false,
    hasAuth: true,
    authRegistered: true,
  });

  await boundary.reconcileTerminalSession("user-1");

  const startIndex = indexOfCall(calls, "start");
  const logoutIndex = indexOfCall(calls, "logout");
  const disconnectIndex = indexOfCall(calls, "disconnect");

  assert.ok(startIndex >= 0);
  assert.ok(logoutIndex > startIndex);
  assert.ok(disconnectIndex > logoutIndex);
  assert.equal(getDbSession().status, "LOGGED_OUT");
});

test("LOGGED_OUT residue is local-cleaned without a second remote logout", async () => {
  const { boundary, calls } = createHarness({
    status: "LOGGED_OUT",
    hasRuntime: false,
    hasAuth: true,
    authRegistered: true,
    connectedAt: null,
  });

  await boundary.reconcileTerminalSession("user-1");

  assert.equal(indexOfCall(calls, "logout"), -1);
  assert.ok(indexOfCall(calls, "disconnect") >= 0);
});

test("unregistered partial pairing residue is safe to clear locally", async () => {
  const { boundary, calls } = createHarness({
    status: "DISCONNECTED",
    connectedAt: null,
    hasRuntime: false,
    hasAuth: true,
    authRegistered: false,
  });

  await boundary.reconcileTerminalSession("user-1");

  assert.equal(indexOfCall(calls, "logout"), -1);
  assert.ok(indexOfCall(calls, "disconnect") >= 0);
});

test("CONNECTED state is never torn down by terminal reconciliation", async () => {
  const { boundary, calls } = createHarness({
    status: "CONNECTED",
  });

  await boundary.reconcileTerminalSession("user-1");

  assert.deepEqual(calls, [["getDb", "user-1"]]);
});

test("missing credentials cannot be disguised as a successful disconnect", async () => {
  const { boundary, calls, getDbSession } = createHarness({
    status: "CONNECTED",
    hasRuntime: false,
    hasAuth: false,
  });

  await assert.rejects(
    boundary.disconnectManagedSessionSafely("user-1"),
    (error) =>
      error?.status === 409 &&
      error?.details?.code === "REMOTE_LOGOUT_UNAVAILABLE"
  );

  assert.equal(getDbSession().status, "CONNECTED");
  assert.equal(indexOfCall(calls, "disconnect"), -1);
});
