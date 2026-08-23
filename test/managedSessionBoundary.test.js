import test from "node:test";
import assert from "node:assert/strict";

import { createManagedSessionBoundary } from "../src/whatsapp/managedSessionBoundary.js";

function createHarness({ status, hasRuntime = false, hasAuth = false }) {
  const calls = [];
  const dbSession = status
    ? { id: "session-user-1", user_id: "user-1", status }
    : null;

  const boundary = createManagedSessionBoundary({
    repository: {
      async getWhatsappSessionByUser(userId) {
        calls.push(["getDb", userId]);
        return dbSession;
      },
    },
    async disconnectSession(sessionId, options) {
      calls.push(["disconnect", sessionId, options]);
    },
    getSession(sessionId) {
      calls.push(["getRuntime", sessionId]);
      return hasRuntime ? { id: sessionId, registered: true } : null;
    },
    async hasSupabaseAuthState(sessionId) {
      calls.push(["hasAuth", sessionId]);
      return hasAuth;
    },
  });

  return { boundary, calls };
}

test("DISCONNECTED with stale registered runtime is fully cleaned", async () => {
  const { boundary, calls } = createHarness({
    status: "DISCONNECTED",
    hasRuntime: true,
    hasAuth: true,
  });

  await boundary.reconcileTerminalSession("user-1");

  assert.deepEqual(calls, [
    ["getDb", "user-1"],
    ["getRuntime", "session-user-1"],
    ["hasAuth", "session-user-1"],
    ["disconnect", "session-user-1", { requestRemoteLogout: false }],
  ]);
});

test("LOGGED_OUT with only stale Supabase auth is fully cleaned", async () => {
  const { boundary, calls } = createHarness({
    status: "LOGGED_OUT",
    hasRuntime: false,
    hasAuth: true,
  });

  await boundary.reconcileTerminalSession("user-1");

  assert.deepEqual(calls, [
    ["getDb", "user-1"],
    ["getRuntime", "session-user-1"],
    ["hasAuth", "session-user-1"],
    ["disconnect", "session-user-1", { requestRemoteLogout: false }],
  ]);
});

test("already-clean terminal state does not repeat auth cleanup on every poll", async () => {
  const { boundary, calls } = createHarness({
    status: "DISCONNECTED",
    hasRuntime: false,
    hasAuth: false,
  });

  await boundary.reconcileTerminalSession("user-1");

  assert.deepEqual(calls, [
    ["getDb", "user-1"],
    ["getRuntime", "session-user-1"],
    ["hasAuth", "session-user-1"],
  ]);
});

test("CONNECTED state is never torn down by the reconciliation boundary", async () => {
  const { boundary, calls } = createHarness({
    status: "CONNECTED",
    hasRuntime: true,
    hasAuth: true,
  });

  await boundary.reconcileTerminalSession("user-1");

  assert.deepEqual(calls, [["getDb", "user-1"]]);
});
