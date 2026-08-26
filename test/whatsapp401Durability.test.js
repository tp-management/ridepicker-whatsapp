import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { createCurrentWhatsappHarness } from "./helpers/createCurrentWhatsappHarness.js";

function fullStreamError401(type = "device_removed") {
  const error = new Error("Stream Errored (conflict)");
  error.statusCode = 401;
  error.data = {
    tag: "stream:error",
    attrs: { code: "401" },
    content: [
      {
        tag: "conflict",
        attrs: { type },
      },
    ],
  };
  return error;
}

function generic401() {
  const error = new Error("Unauthorized");
  error.statusCode = 401;
  return error;
}

async function connectedHarness(t, userId) {
  const harness = await createCurrentWhatsappHarness();
  t.after(async () => {
    for (const session of harness.whatsapp.__characterization.sessions.values()) {
      if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
      if (session.recoveryStableTimer) clearTimeout(session.recoveryStableTimer);
    }
    await harness.cleanup();
  });

  const row = await harness.repositoryStub.repository.ensureWhatsappSession(userId);
  const session = await harness.whatsapp.startSession(row.id, { userId });
  const socket = session.socket;
  socket.authState.creds.registered = true;
  socket.user = { id: "37061234567@s.whatsapp.net", name: "Test" };
  await socket.ev.emit("creds.update", socket.authState.creds);
  await socket.ev.emit("connection.update", { connection: "open" });
  row.bot_mode = "assist";

  return { harness, row, session, socket };
}

test("current Baileys stream:error device_removed gets one confirmation retry, then durable relink quarantine", async (t) => {
  const { harness, row, session, socket } = await connectedHarness(t, "full-stream-device-removed");
  const connectedAt = row.connected_at;

  await socket.ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: fullStreamError401("device_removed") },
  });

  assert.equal(row.status, "RECONNECTING");
  assert.equal(row.recovery_state, "recovering");
  assert.equal(row.recovery_attempt_count, 1);
  assert.equal(row.recovery_reason_tag, "conflict");
  assert.equal(row.recovery_conflict_type, "device_removed");
  assert.equal(row.bot_mode, "assist");
  assert.equal(row.connected_at, connectedAt);
  assert.equal(socket.authState.creds.registered, true);
  assert.ok(session.reconnectTimer);

  clearTimeout(session.reconnectTimer);
  session.reconnectTimer = null;

  await socket.ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: fullStreamError401("device_removed") },
  });

  assert.equal(row.status, "ERROR");
  assert.equal(row.recovery_state, "relink_required");
  assert.equal(row.recovery_attempt_count, 2);
  assert.equal(row.bot_mode, "assist");
  assert.equal(row.connected_at, connectedAt);
  assert.equal(socket.authState.creds.registered, true);
  assert.equal(harness.whatsapp.__characterization.sessions.has(row.id), false);
  assert.equal(
    harness.repositoryStub.__getActivities().some(
      (entry) => entry.title === "WhatsApp disconnected"
    ),
    false
  );
});

test("generic unsolicited 401 budget is bounded independently of transient opens", async (t) => {
  const { harness, row, session, socket } = await connectedHarness(t, "generic-401-budget");

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (attempt > 1 && harness.whatsapp.__characterization.sessions.has(row.id)) {
      await socket.ev.emit("connection.update", { connection: "open" });
    }

    await socket.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: generic401() },
    });

    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }
  }

  assert.equal(row.status, "ERROR");
  assert.equal(row.recovery_state, "relink_required");
  assert.equal(row.recovery_attempt_count, 4);
  assert.equal(harness.whatsapp.__characterization.sessions.has(row.id), false);
  assert.equal(socket.authState.creds.registered, true);
});

test("real notify traffic proves a recovered connection healthy and resets durable incident", async (t) => {
  const { harness, row, session, socket } = await connectedHarness(t, "message-proves-stable");

  await socket.ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: fullStreamError401("device_removed") },
  });
  assert.equal(row.recovery_state, "recovering");

  clearTimeout(session.reconnectTimer);
  session.reconnectTimer = null;

  // Build the same-auth replacement socket without waiting for the real 2s timer.
  const replacement = await harness.whatsapp.startSession(row.id, {
    userId: "message-proves-stable",
  });
  const replacementSocket = replacement.socket;
  replacementSocket.authState.creds.registered = true;
  replacementSocket.user = { id: "37061234567@s.whatsapp.net", name: "Test" };
  await replacementSocket.ev.emit("creds.update", replacementSocket.authState.creds);
  await replacementSocket.ev.emit("connection.update", { connection: "open" });

  assert.equal(row.status, "CONNECTED");
  assert.equal(row.recovery_state, "recovering");

  await replacementSocket.ev.emit("messages.upsert", {
    type: "notify",
    messages: [],
  });

  // markSessionRecoveryHealthy is async from the event handler.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(row.recovery_state, "idle");
  assert.equal(row.recovery_attempt_count, 0);
});

test("only centralized production helper invokes native socket.logout", async () => {
  const [whatsappSource, boundarySource] = await Promise.all([
    fs.readFile("src/whatsapp.js", "utf8"),
    fs.readFile("src/whatsapp/managedSessionBoundary.js", "utf8"),
  ]);

  const nativeLogoutCalls = whatsappSource.match(/await socket\.logout\(\)/g) || [];
  assert.equal(nativeLogoutCalls.length, 1);
  assert.match(whatsappSource, /export async function requestRemoteLogoutForSession/);
  assert.doesNotMatch(boundarySource, /await runtimeSession\.socket\.logout\(\)/);
  assert.match(boundarySource, /requestRemoteLogoutForSessionAdapter\(runtimeSession\)/);
});

test("migration never turns an unsolicited 401 into LOGGED_OUT and limits relink cleanup to quarantined ERROR", async () => {
  const sql = await fs.readFile(
    "supabase/migrations/20260826_harden_unexpected_401_recovery.sql",
    "utf8"
  );

  const registerBody = sql.match(
    /CREATE OR REPLACE FUNCTION public\.register_whatsapp_unexpected_401[\s\S]*?\$\$;/i
  )?.[0];
  const relinkBody = sql.match(
    /CREATE OR REPLACE FUNCTION public\.ridepicker_whatsapp_auth_prepare_relink[\s\S]*?\$\$;/i
  )?.[0];

  assert.ok(registerBody);
  assert.doesNotMatch(registerBody, /status\s*=\s*'LOGGED_OUT'/i);
  assert.match(registerBody, /FOR UPDATE/i);
  assert.match(registerBody, /'relink_required'/i);

  assert.ok(relinkBody);
  assert.match(relinkBody, /v_status\s*<>\s*'ERROR'/i);
  assert.match(relinkBody, /v_recovery_state\s*<>\s*'relink_required'/i);
  assert.match(relinkBody, /DELETE FROM public\.whatsapp_auth/i);

  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION public\.ridepicker_whatsapp_auth_prepare_relink[\s\S]*FROM PUBLIC, anon, authenticated/i
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION public\.ridepicker_whatsapp_auth_prepare_relink[\s\S]*TO service_role/i
  );
});
