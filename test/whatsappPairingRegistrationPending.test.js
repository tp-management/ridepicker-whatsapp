import test from "node:test";
import assert from "node:assert/strict";
import { createCurrentWhatsappHarness } from "./helpers/createCurrentWhatsappHarness.js";

async function startPairing(t, userId) {
  const h = await createCurrentWhatsappHarness();
  t.after(async () => {
    const { sessions, managedPairingFlows } = h.whatsapp.__characterization;
    for (const flow of managedPairingFlows.values()) {
      if (flow.retryTimer) clearTimeout(flow.retryTimer);
      if (flow.rotateTimer) clearTimeout(flow.rotateTimer);
      flow.active = false;
    }
    for (const session of sessions.values()) {
      if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
      if (session.recoveryStableTimer) clearTimeout(session.recoveryStableTimer);
    }
    await h.cleanup();
  });
  const result = await h.whatsapp.requestManagedPairingCode(userId, "+37061234567");
  assert.ok(result.pairingCode?.code);
  const session = h.whatsapp.__characterization.sessions.get(result.sessionId);
  const flow = h.whatsapp.__characterization.managedPairingFlows.get(result.sessionId);
  return { h, session, flow, result };
}

test("registered credentials are not a connected WhatsApp session", async t => {
  const { h, session, flow, result } = await startPairing(t, "registered-not-open");
  session.socket.authState.creds.registered = true;
  await session.socket.ev.emit("creds.update", session.socket.authState.creds);
  assert.equal(session.registered, true);
  assert.equal(session.openedOnce, false);
  assert.equal(flow.active, true);
  assert.equal(flow.published, false);

  await session.socket.ev.emit("connection.update", { qr: "stale-qr-after-phone-confirmation" });
  assert.equal(flow.active, true, "stale QR must not stop pending pairing");
  assert.equal(h.repositoryStub.__getSessionRow("registered-not-open").status, "STARTING");

  await assert.rejects(
    h.whatsapp.requestManagedPairingCode("registered-not-open", "+37061234567"),
    e => e?.status === 409 && e?.details?.code === "PAIRING_FINALIZING"
      && !e.message.includes("already connected")
  );
  assert.equal(flow.active, true, "requesting code while finalizing must not stop flow");

  await session.socket.ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: Object.assign(new Error("QR refs attempts ended"), { statusCode: 408 }) },
  });
  const row = h.repositoryStub.__getSessionRow("registered-not-open");
  assert.equal(row.recovery_attempt_count, 0,
    "pre-open pairing 408 should not start ordinary 401 recovery");
  assert.equal(row.status, "STARTING");
  assert.ok(flow.retryTimer || flow.requestInFlight || flow.retryAt,
    "failed pre-open pairing should use bounded pairing recovery");
});

test("successful WhatsApp open completes managed pairing and enables Assist", async t => {
  const { h, session, flow } = await startPairing(t, "pairing-open");
  session.socket.authState.creds.registered = true;
  session.socket.user = { id: "37061234567@s.whatsapp.net", name: "Driver" };
  await session.socket.ev.emit("creds.update", session.socket.authState.creds);
  assert.equal(flow.active, true);
  await session.socket.ev.emit("connection.update", { connection: "open" });
  const row = h.repositoryStub.__getSessionRow("pairing-open");
  assert.equal(row.status, "CONNECTED");
  assert.equal(row.bot_mode, "assist");
  assert.equal(h.whatsapp.__characterization.managedPairingFlows.has(row.id), false);
});
