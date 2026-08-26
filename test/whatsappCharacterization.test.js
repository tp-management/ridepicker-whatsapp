import test from "node:test";
import assert from "node:assert/strict";

import { createCurrentWhatsappHarness } from "./helpers/createCurrentWhatsappHarness.js";

const PHONE = "+37061234567";

function totalQueryCalls(baileys) {
  return baileys.__getSockets().reduce(
    (total, socket) => total + socket.queryCalls,
    0
  );
}

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for characterization condition");
}

function disconnectError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function clearRuntimeTimers(whatsapp) {
  const { sessions, managedPairingFlows } = whatsapp.__characterization;

  for (const flow of managedPairingFlows.values()) {
    if (flow.retryTimer) clearTimeout(flow.retryTimer);
    if (flow.rotateTimer) clearTimeout(flow.rotateTimer);
    flow.retryTimer = null;
    flow.rotateTimer = null;
    flow.active = false;
  }

  for (const session of sessions.values()) {
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
}

async function useHarness(t) {
  const harness = await createCurrentWhatsappHarness();
  t.after(async () => {
    clearRuntimeTimers(harness.whatsapp);
    await harness.cleanup();
  });
  return harness;
}

async function startManagedPairing(harness, userId) {
  const result = await harness.whatsapp.requestManagedPairingCode(userId, PHONE);
  assert.ok(result?.pairingCode?.code, "expected a published pairing code");

  const sessionId = result.sessionId;
  const flow = harness.whatsapp.__characterization.managedPairingFlows.get(sessionId);
  const session = harness.whatsapp.__characterization.sessions.get(sessionId);

  assert.ok(flow, "expected managed pairing flow");
  assert.ok(session, "expected active session");

  return { result, sessionId, flow, session };
}

test("early 408 increments failureCount and schedules bounded retry", async (t) => {
  const harness = await useHarness(t);
  const { flow, session } = await startManagedPairing(harness, "early-408");
  const socket = session.socket;

  await socket.ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: {
      error: disconnectError(408, "QR refs attempts ended"),
    },
  });

  assert.equal(flow.failureCount, 1);
  assert.equal(flow.active, true);
  assert.ok(flow.retryTimer, "expected bounded retry timer");
  assert.ok(flow.retryAt, "expected retry ETA");
});

test("old published code plus 408 takes natural-expiry replacement path", async (t) => {
  const harness = await useHarness(t);
  const { flow, session } = await startManagedPairing(harness, "old-408");
  const socket = session.socket;

  flow.published = true;
  flow.codeIssuedAt = new Date(Date.now() - 121_000).toISOString();

  await socket.ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: {
      error: disconnectError(408, "QR refs attempts ended"),
    },
  });

  assert.equal(flow.failureCount, 0);
  assert.equal(flow.retryTimer, null);

  await waitFor(() => totalQueryCalls(harness.baileys) >= 2);
  assert.ok(totalQueryCalls(harness.baileys) >= 2);
});

test("429 or rate-overlimit stops automatic retry and sets cooldown", async (t) => {
  const harness = await useHarness(t);

  harness.baileys.__setQueryHandler(async () => {
    throw disconnectError(429, "rate-overlimit");
  });

  await assert.rejects(
    harness.whatsapp.requestManagedPairingCode("rate-limited", PHONE),
    (error) => error?.status === 429 && error?.message === "rate-overlimit"
  );

  const sessionId = "session-rate-limited";
  const flow = harness.whatsapp.__characterization.managedPairingFlows.get(sessionId);

  assert.ok(flow);
  assert.equal(flow.active, false);
  assert.equal(flow.retryTimer, null);
  assert.ok(flow.rateLimitUntil);
  assert.equal(totalQueryCalls(harness.baileys), 1);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(totalQueryCalls(harness.baileys), 1);
});

test("two concurrent pairing triggers issue exactly one companion request", async (t) => {
  const harness = await useHarness(t);

  let releaseQuery;
  const queryGate = new Promise((resolve) => {
    releaseQuery = resolve;
  });

  harness.baileys.__setQueryHandler(async () => {
    await queryGate;
    return harness.baileys.__defaultPairingResponse();
  });

  const first = harness.whatsapp.requestManagedPairingCode("single-flight", PHONE);
  const second = harness.whatsapp.requestManagedPairingCode("single-flight", PHONE);

  await waitFor(() => totalQueryCalls(harness.baileys) === 1);
  assert.equal(totalQueryCalls(harness.baileys), 1);

  releaseQuery();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.ok(firstResult?.pairingCode?.code);
  assert.ok(secondResult?.pairingCode?.code);
  assert.equal(totalQueryCalls(harness.baileys), 1);
});

test("HelloAck without pairing ref fails without publishing code or setting creds.me", async (t) => {
  const harness = await useHarness(t);
  const userId = "hello-ack-missing-ref";

  harness.baileys.__setQueryHandler(async () => ({
    tag: "iq",
    attrs: {},
    content: [
      {
        tag: "link_code_companion_reg",
        attrs: {},
        content: [],
      },
    ],
  }));

  await assert.rejects(
    harness.whatsapp.requestManagedPairingCode(userId, PHONE),
    (error) =>
      error?.message ===
      "WhatsApp did not return a pairing reference for the new code."
  );

  const sessionId = `session-${userId}`;
  const flow = harness.whatsapp.__characterization.managedPairingFlows.get(sessionId);
  const socket = harness.baileys.__getSockets()[0];

  assert.ok(flow, "expected failed pairing flow to remain observable");
  assert.equal(flow.published, false);
  assert.equal(flow.code, null);
  assert.equal(
    harness.whatsapp.__characterization.sessions.get(sessionId)?.pairingCode || null,
    null
  );
  assert.equal(socket.authState.creds.pairingCode, undefined);
  assert.equal(socket.authState.creds.me, null);
  assert.equal(totalQueryCalls(harness.baileys), 1);
});

test("registered pairing followed by 515 enters lifecycle restart path", async (t) => {
  const harness = await useHarness(t);
  const { session } = await startManagedPairing(harness, "restart-515");
  const socket = session.socket;

  socket.authState.creds.registered = true;
  socket.user = {
    id: "37061234567@s.whatsapp.net",
    name: "Test",
  };

  await socket.ev.emit("creds.update", socket.authState.creds);
  assert.equal(session.registered, true);

  await socket.ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: {
      error: disconnectError(515, "restart required"),
    },
  });

  assert.equal(session.status, "RECONNECTING");
  assert.ok(session.reconnectTimer, "expected lifecycle reconnect timer");

  await waitFor(() => harness.baileys.__getSockets().length === 2);
  const replacementSocket = harness.baileys.__getSockets()[1];
  const replacementSession =
    harness.whatsapp.__characterization.sessions.get("session-restart-515");

  assert.notEqual(replacementSocket, socket);
  assert.ok(replacementSession, "expected replacement session");
  assert.notEqual(replacementSession, session);
  assert.equal(replacementSession.registered, true);
  assert.equal(replacementSocket.authState.creds.registered, true);
  assert.equal(
    replacementSocket.authState.creds.me?.id,
    socket.authState.creds.me?.id
  );
});

test("managed logout uses Baileys native socket.logout", async (t) => {
  const harness = await useHarness(t);
  const userId = "logout-native";
  const row = await harness.repositoryStub.repository.ensureWhatsappSession(userId);
  const session = await harness.whatsapp.startSession(row.id, { userId });
  const socket = session.socket;

  harness.repositoryStub.__setSessionStatus(userId, "CONNECTED");
  await harness.whatsapp.disconnectManagedSession(userId);

  assert.equal(socket.logoutCalls, 1);
});

test("repeated reconnect triggers do not schedule duplicate active reconnects", async (t) => {
  const harness = await useHarness(t);
  const session = await harness.whatsapp.startSession("reconnect-dedupe", {
    userId: "reconnect-user",
  });
  const socket = session.socket;

  await new Promise((resolve) => setTimeout(resolve, 10));

  const closeUpdate = {
    connection: "close",
    lastDisconnect: {
      error: disconnectError(500, "transport closed"),
    },
  };

  await socket.ev.emit("connection.update", closeUpdate);
  const firstTimer = session.reconnectTimer;

  assert.ok(firstTimer);
  assert.equal(harness.baileys.__getSockets().length, 1);

  await socket.ev.emit("connection.update", closeUpdate);

  assert.equal(session.reconnectTimer, firstTimer);
  assert.equal(harness.baileys.__getSockets().length, 1);
});

test("restore without Supabase auth records an infrastructure disconnect", async (t) => {
  const harness = await useHarness(t);
  const userId = "restore-missing-auth";
  await harness.repositoryStub.repository.ensureWhatsappSession(userId);
  harness.repositoryStub.__setSessionStatus(userId, "CONNECTED");

  await harness.whatsapp.restoreSessions();

  assert.equal(harness.repositoryStub.__getSessionRow(userId).status, "DISCONNECTED");
  assert.ok(
    harness.repositoryStub.__getActivities().some(
      (entry) =>
        entry.userId === userId &&
        entry.type === "whatsapp" &&
        entry.title === "WhatsApp disconnected"
    ),
    "expected restore disconnect to be visible in Activity"
  );
});


test("unexpected established 401 preserves auth and uses bounded recovery", async (t) => {
  const harness = await useHarness(t);
  const userId = "unexpected-401";
  const row = await harness.repositoryStub.repository.ensureWhatsappSession(userId);
  const session = await harness.whatsapp.startSession(row.id, { userId });
  const socket = session.socket;

  socket.authState.creds.registered = true;
  socket.user = { id: "37061234567@s.whatsapp.net", name: "Test" };
  await socket.ev.emit("creds.update", socket.authState.creds);
  await socket.ev.emit("connection.update", { connection: "open" });

  row.bot_mode = "assist";
  const connectedAt = row.connected_at;
  const error = disconnectError(401, "Stream Errored (conflict)");
  error.data = { tag: "conflict", attrs: { type: "device_removed" } };

  await socket.ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error },
  });

  assert.equal(row.status, "RECONNECTING");
  assert.equal(row.bot_mode, "assist");
  assert.equal(row.connected_at, connectedAt);
  assert.equal(socket.authState.creds.registered, true);
  assert.ok(session.reconnectTimer, "expected a bounded recovery timer");
  assert.equal(
    harness.repositoryStub.__getActivities().filter(
      (entry) => entry.title === "WhatsApp disconnected"
    ).length,
    0
  );
});

test("unexpected 401 exhausts into ERROR without deleting registered auth", async (t) => {
  const harness = await useHarness(t);
  const userId = "unexpected-401-exhausted";
  const row = await harness.repositoryStub.repository.ensureWhatsappSession(userId);
  const session = await harness.whatsapp.startSession(row.id, { userId });
  const socket = session.socket;

  socket.authState.creds.registered = true;
  socket.user = { id: "37061234567@s.whatsapp.net", name: "Test" };
  await socket.ev.emit("creds.update", socket.authState.creds);
  await socket.ev.emit("connection.update", { connection: "open" });
  row.bot_mode = "assist";

  for (let index = 0; index < 4; index += 1) {
    // A recovery socket that only opens briefly must not reset the bounded
    // retry budget. Otherwise conflict -> open -> conflict could loop forever.
    if (index > 0) {
      await socket.ev.emit("connection.update", { connection: "open" });
    }

    const error = disconnectError(401, "Stream Errored (conflict)");
    error.data = { tag: "conflict", attrs: { type: "device_removed" } };
    await socket.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error },
    });

    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }
  }

  assert.equal(row.status, "ERROR");
  assert.equal(row.bot_mode, "assist");
  assert.equal(socket.authState.creds.registered, true);
  assert.equal(harness.whatsapp.__characterization.sessions.has(row.id), false);
  assert.equal(
    harness.repositoryStub.__getActivities().filter(
      (entry) => entry.title === "WhatsApp disconnected"
    ).length,
    0
  );
});

test("locally requested logout close is finalized by the caller, not connection.update", async (t) => {
  const harness = await useHarness(t);
  const userId = "local-logout-owner";
  const row = await harness.repositoryStub.repository.ensureWhatsappSession(userId);
  const session = await harness.whatsapp.startSession(row.id, { userId });
  const socket = session.socket;

  socket.authState.creds.registered = true;
  socket.user = { id: "37061234567@s.whatsapp.net", name: "Test" };
  await socket.ev.emit("creds.update", socket.authState.creds);
  await socket.ev.emit("connection.update", { connection: "open" });

  session.logoutRequested = true;
  session.logoutRequestedAt = new Date().toISOString();
  await socket.ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: disconnectError(401, "Intentional Logout") },
  });

  assert.equal(row.status, "CONNECTED");
  assert.equal(session.reconnectTimer, null);
  assert.equal(
    harness.repositoryStub.__getActivities().filter(
      (entry) => entry.title === "WhatsApp disconnected"
    ).length,
    0
  );
});
