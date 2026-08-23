import test from "node:test";
import assert from "node:assert/strict";

import { createManagedSessionBoundary } from "../src/whatsapp/managedSessionBoundary.js";

for (const status of ["ERROR", "STARTING", "QR"]) {
  test(`${status} + registered auth is recovered before downstream pairing can clear it`, async () => {
    const calls = [];
    let row = {
      id: "session-1",
      user_id: "user-1",
      status,
      bot_mode: "assist",
      connected_at: null,
    };
    let runtime = null;

    const boundary = createManagedSessionBoundary({
      repository: {
        async getWhatsappSessionByUser() {
          calls.push(["getDb"]);
          return row;
        },
        async updateWhatsappSessionById(id, patch) {
          calls.push(["updateDb", patch]);
          row = { ...row, ...patch };
          return row;
        },
        async addActivity() {},
      },
      async disconnectSession() {
        calls.push(["disconnectLocal"]);
      },
      async getManagedSession() { return null; },
      getSession() { return runtime; },
      async startSession() {
        calls.push(["start"]);
        runtime = {
          id: row.id,
          registered: true,
          openedOnce: false,
          status: "STARTING",
          socket: { end() {} },
          disposed: false,
        };
        return runtime;
      },
      async hasSupabaseAuthState() { return true; },
      async loadSupabaseAuthState() {
        return { state: { creds: { registered: true } } };
      },
      async clearSupabaseAuthState() { calls.push(["clearAuth"]); },
      updatePolicyCache() {},
      async writeSystemLog() {},
      async sleep() {},
    });

    await boundary.reconcileTerminalSession("user-1");

    assert.ok(calls.some((call) => call[0] === "start"));
    assert.equal(calls.some((call) => call[0] === "clearAuth"), false);
    assert.equal(calls.some((call) => call[0] === "disconnectLocal"), false);
  });
}
