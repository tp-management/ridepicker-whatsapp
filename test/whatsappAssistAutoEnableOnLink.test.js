import test from "node:test";
import assert from "node:assert/strict";
import { createCurrentWhatsappHarness } from "./helpers/createCurrentWhatsappHarness.js";

async function setup(t, userId, subscription = { status: "active" }) {
  const harness = await createCurrentWhatsappHarness();
  t.after(async () => {
    const { sessions, managedPairingFlows } = harness.whatsapp.__characterization;
    for (const flow of managedPairingFlows.values()) {
      if (flow.retryTimer) clearTimeout(flow.retryTimer);
      if (flow.rotateTimer) clearTimeout(flow.rotateTimer);
    }
    for (const session of sessions.values()) {
      if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
      if (session.recoveryStableTimer) clearTimeout(session.recoveryStableTimer);
    }
    await harness.cleanup();
  });
  harness.repositoryStub.__setSubscription(userId, subscription);
  const row = await harness.repositoryStub.repository.ensureWhatsappSession(userId);
  return { harness, row };
}

async function connect(session) {
  session.socket.authState.creds.registered = true;
  session.socket.user = { id: "37061234567@s.whatsapp.net", name: "Driver" };
  await session.socket.ev.emit("creds.update", session.socket.authState.creds);
  await session.socket.ev.emit("connection.update", { connection: "open" });
}

test("fresh WhatsApp pairing automatically enables Assist for an active subscriber", async (t) => {
  const { harness, row } = await setup(t, "first-link");
  row.status = "STARTING";
  row.bot_mode = "off";
  const session = await harness.whatsapp.startSession(row.id, { userId: row.user_id });
  await connect(session);
  assert.equal(row.status, "CONNECTED");
  assert.equal(row.bot_mode, "assist");
  assert.ok(row.connected_at);
  assert.ok(harness.repositoryStub.__getActivities().some(x => x.title === "RidePicker Assist enabled"));
});

test("a new explicit WhatsApp link enables Assist even after an earlier OFF choice", async (t) => {
  const { harness, row } = await setup(t, "relink");
  row.status = "STARTING";
  row.bot_mode = "off";
  row.connected_at = null; // Explicit logout cleared previous link evidence.
  const session = await harness.whatsapp.startSession(row.id, { userId: row.user_id });
  await connect(session);
  assert.equal(row.bot_mode, "assist");
});

test("transient WhatsApp reconnect does NOT override user's manual Assist OFF", async (t) => {
  const { harness, row } = await setup(t, "existing-linked");
  row.status = "RECONNECTING";
  row.bot_mode = "off";
  row.connected_at = "2026-10-30T12:00:00.000Z";
  const session = await harness.whatsapp.startSession(row.id, { userId: row.user_id });
  await connect(session);
  assert.equal(row.bot_mode, "off");
  assert.equal(harness.repositoryStub.__getActivities().filter(x => x.title === "RidePicker Assist enabled").length, 0);
});

test("after fresh link, manually turning Assist OFF survives another socket open", async (t) => {
  const { harness, row } = await setup(t, "manual-off");
  row.status = "STARTING";
  const session = await harness.whatsapp.startSession(row.id, { userId: row.user_id });
  await connect(session);
  assert.equal(row.bot_mode, "assist");
  row.bot_mode = "off";
  await session.socket.ev.emit("connection.update", { connection: "open" });
  assert.equal(row.bot_mode, "off");
});

test("fresh pairing does not bypass Premium subscription check", async (t) => {
  const { harness, row } = await setup(t, "not-eligible", { status: "payment_required" });
  row.status = "STARTING";
  const session = await harness.whatsapp.startSession(row.id, { userId: row.user_id });
  await connect(session);
  assert.equal(row.status, "CONNECTED");
  assert.equal(row.bot_mode, "off");
});

test("a cancelled subscription with remaining paid time may enable Assist", async (t) => {
  const { harness, row } = await setup(t, "cancelled-active", {
    status: "cancelled", current_period_end: new Date(Date.now() + 86400000).toISOString(),
  });
  row.status = "STARTING";
  const session = await harness.whatsapp.startSession(row.id, { userId: row.user_id });
  await connect(session);
  assert.equal(row.bot_mode, "assist");
});
