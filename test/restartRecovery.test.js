import test from "node:test";
import assert from "node:assert/strict";

import { createRestartRecovery } from "../src/whatsapp/restartRecovery.js";

function harness(sessionOverrides = {}, auth = {}) {
  const calls = [];
  let dbSession = {
    id: "session-1",
    user_id: "user-1",
    status: "CONNECTED",
    bot_mode: "assist",
    connected_at: "2026-08-23T20:00:00.000Z",
    ...sessionOverrides,
  };

  const recovery = createRestartRecovery({
    repository: {
      async listWhatsappSessions() {
        calls.push(["list"]);
        return [dbSession];
      },
      async updateWhatsappSessionById(id, patch) {
        calls.push(["update", id, patch]);
        dbSession = { ...dbSession, ...patch };
        return dbSession;
      },
    },
    async startSession(id, options) {
      calls.push(["start", id, options]);
      if (auth.startError) throw auth.startError;
      return { id, registered: true };
    },
    async hasSupabaseAuthState(id) {
      calls.push(["hasAuth", id]);
      return Boolean(auth.exists);
    },
    async loadSupabaseAuthState(id) {
      calls.push(["loadAuth", id]);
      return { state: { creds: { registered: Boolean(auth.registered) } } };
    },
    async clearSupabaseAuthState(id) {
      calls.push(["clearAuth", id]);
    },
    updatePolicyCache(row) {
      calls.push(["policy", row.status]);
    },
    async writeSystemLog(entry) {
      calls.push(["log", entry.event, entry.details]);
    },
  });

  return { recovery, calls, db: () => dbSession };
}

for (const status of ["STARTING", "QR", "ERROR", "DISCONNECTED", "RECONNECTING", "CONNECTED"]) {
  test(`${status} + registered auth is restored and never cleared`, async () => {
    const connectedAt = status === "CONNECTED" || status === "RECONNECTING"
      ? "2026-08-23T20:00:00.000Z"
      : null;
    const { recovery, calls } = harness(
      { status, connected_at: connectedAt },
      { exists: true, registered: true }
    );

    const result = await recovery.recoverOne({
      id: "session-1",
      user_id: "user-1",
      status,
      bot_mode: "assist",
      connected_at: connectedAt,
    });

    assert.equal(result.action, "restored_registered");
    assert.ok(calls.some((call) => call[0] === "start"));
    assert.equal(calls.some((call) => call[0] === "clearAuth"), false);
  });
}

test("CONNECTED with missing auth fails closed without pretending DISCONNECTED", async () => {
  const { recovery, calls, db } = harness({}, { exists: false });

  const result = await recovery.recoverOne(db());

  assert.equal(result.action, "unusable_linked_auth_preserved");
  assert.equal(db().status, "ERROR");
  assert.equal(db().bot_mode, "off");
  assert.equal(calls.some((call) => call[0] === "clearAuth"), false);
  assert.equal(calls.some((call) => call[0] === "start"), false);
});

test("previously linked row with unregistered auth preserves residue for investigation", async () => {
  const { recovery, calls, db } = harness(
    { status: "ERROR", connected_at: "2026-08-23T20:00:00.000Z" },
    { exists: true, registered: false }
  );

  const result = await recovery.recoverOne(db());

  assert.equal(result.action, "unusable_linked_auth_preserved");
  assert.equal(db().status, "ERROR");
  assert.equal(calls.some((call) => call[0] === "clearAuth"), false);
});

test("never-connected partial pairing is the only restart state cleared locally", async () => {
  const { recovery, calls, db } = harness(
    { status: "STARTING", connected_at: null },
    { exists: true, registered: false }
  );

  const result = await recovery.recoverOne(db());

  assert.equal(result.action, "unregistered_pairing_reset");
  assert.equal(db().status, "DISCONNECTED");
  assert.equal(db().bot_mode, "off");
  assert.ok(calls.some((call) => call[0] === "clearAuth"));
  assert.equal(calls.some((call) => call[0] === "start"), false);
});

test("LOGGED_OUT never rehydrates and only removes local auth residue", async () => {
  const { recovery, calls, db } = harness(
    { status: "LOGGED_OUT", connected_at: null, bot_mode: "off" },
    { exists: true, registered: true }
  );

  const result = await recovery.recoverOne(db());

  assert.equal(result.action, "logged_out_cleanup");
  assert.ok(calls.some((call) => call[0] === "clearAuth"));
  assert.equal(calls.some((call) => call[0] === "start"), false);
});

test("registered auth restore failure preserves auth and remains recoverable", async () => {
  const failure = new Error("socket construction failed");
  const { recovery, calls, db } = harness(
    { status: "STARTING", connected_at: null },
    { exists: true, registered: true, startError: failure }
  );

  const result = await recovery.recoverOne(db());

  assert.equal(result.action, "restore_failed_auth_preserved");
  assert.equal(db().status, "RECONNECTING");
  assert.equal(calls.some((call) => call[0] === "clearAuth"), false);
  assert.ok(
    calls.some(
      (call) => call[0] === "log" && call[1] === "session_restore_failed" && call[2]?.authPreserved
    )
  );
});

test("one broken durable session cannot stop recovery of another", async () => {
  const calls = [];
  const sessions = [
    { id: "bad", user_id: "u-bad", status: "CONNECTED", connected_at: null },
    { id: "good", user_id: "u-good", status: "CONNECTED", connected_at: null },
  ];

  const recovery = createRestartRecovery({
    repository: {
      async listWhatsappSessions() { return sessions; },
      async updateWhatsappSessionById() { return null; },
    },
    async hasSupabaseAuthState(id) {
      if (id === "bad") throw new Error("bad row");
      return true;
    },
    async loadSupabaseAuthState() {
      return { state: { creds: { registered: true } } };
    },
    async clearSupabaseAuthState() {},
    async startSession(id) { calls.push(["start", id]); },
    async writeSystemLog(entry) { calls.push(["log", entry.sessionId, entry.event]); },
  });

  const results = await recovery.recoverAll();

  assert.equal(results.length, 2);
  assert.equal(results[0].action, "unexpected_failure");
  assert.equal(results[1].action, "restored_registered");
  assert.ok(calls.some((call) => call[0] === "start" && call[1] === "good"));
});
