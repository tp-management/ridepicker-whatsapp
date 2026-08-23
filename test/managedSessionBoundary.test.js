import test from "node:test";
import assert from "node:assert/strict";

import { createManagedSessionBoundary } from "../src/whatsapp/managedSessionBoundary.js";

function createHarness(status) {
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
    async getManagedSession(userId) {
      calls.push(["getManaged", userId]);
      return { status: status === "CONNECTED" ? "connected" : "disconnected" };
    },
    async requestManagedPairingCode(userId, phone) {
      calls.push(["pair", userId, phone]);
      return { pairingCode: { code: "ABCDEFGH" } };
    },
    async startManagedSession(userId, options) {
      calls.push(["start", userId, options]);
      return { status: "starting" };
    },
  });

  return { boundary, calls };
}

test("DISCONNECTED is fully cleaned before a new pairing code request", async () => {
  const { boundary, calls } = createHarness("DISCONNECTED");

  const result = await boundary.requestFreshManagedPairingCode(
    "user-1",
    "+37061234567"
  );

  assert.equal(result.pairingCode.code, "ABCDEFGH");
  assert.deepEqual(calls, [
    ["getDb", "user-1"],
    ["disconnect", "session-user-1", { requestRemoteLogout: false }],
    ["pair", "user-1", "+37061234567"],
  ]);
});

test("LOGGED_OUT is fully cleaned before returning frontend state", async () => {
  const { boundary, calls } = createHarness("LOGGED_OUT");

  await boundary.getReconciledManagedSession("user-1");

  assert.deepEqual(calls, [
    ["getDb", "user-1"],
    ["disconnect", "session-user-1", { requestRemoteLogout: false }],
    ["getManaged", "user-1"],
  ]);
});

test("terminal state is fully cleaned before any managed start", async () => {
  const { boundary, calls } = createHarness("DISCONNECTED");

  await boundary.startFreshManagedSession("user-1", {
    method: "pairing_code",
    phone: "+37061234567",
  });

  assert.deepEqual(calls, [
    ["getDb", "user-1"],
    ["disconnect", "session-user-1", { requestRemoteLogout: false }],
    [
      "start",
      "user-1",
      { method: "pairing_code", phone: "+37061234567" },
    ],
  ]);
});

test("CONNECTED state is not torn down", async () => {
  const { boundary, calls } = createHarness("CONNECTED");

  await boundary.requestFreshManagedPairingCode("user-1", "+37061234567");

  assert.deepEqual(calls, [
    ["getDb", "user-1"],
    ["pair", "user-1", "+37061234567"],
  ]);
});
