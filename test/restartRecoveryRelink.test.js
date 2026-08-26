import test from "node:test";
import assert from "node:assert/strict";

import { createRestartRecovery } from "../src/whatsapp/restartRecovery.js";

test("restart does not revive or clear registered auth once durable state requires relinking", async () => {
  const calls = [];
  const dbSession = {
    id: "session-relink",
    user_id: "user-relink",
    status: "ERROR",
    bot_mode: "assist",
    connected_at: "2026-08-26T12:00:00.000Z",
    recovery_state: "relink_required",
    recovery_attempt_count: 2,
  };

  const recovery = createRestartRecovery({
    repository: {
      async listWhatsappSessions() {
        return [dbSession];
      },
      async updateWhatsappSessionById(id, patch) {
        calls.push(["update", id, patch]);
        Object.assign(dbSession, patch);
        return dbSession;
      },
    },
    async startSession(id) {
      calls.push(["start", id]);
      return { id };
    },
    async hasSupabaseAuthState(id) {
      calls.push(["hasAuth", id]);
      return true;
    },
    async loadSupabaseAuthState(id) {
      calls.push(["loadAuth", id]);
      return { state: { creds: { registered: true } } };
    },
    async clearSupabaseAuthState(id) {
      calls.push(["clearAuth", id]);
    },
    async writeSystemLog(entry) {
      calls.push(["log", entry.event, entry.details]);
    },
  });

  const result = await recovery.recoverOne(dbSession);

  assert.equal(result.action, "relink_required_auth_preserved");
  assert.equal(calls.some((call) => call[0] === "start"), false);
  assert.equal(calls.some((call) => call[0] === "clearAuth"), false);
  assert.equal(dbSession.status, "ERROR");
  assert.equal(dbSession.recovery_state, "relink_required");
  assert.ok(
    calls.some(
      (call) =>
        call[0] === "log" &&
        call[1] === "session_restore_relink_required" &&
        call[2]?.authPreserved === true
    )
  );
});
