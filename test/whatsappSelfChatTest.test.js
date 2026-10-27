import test from "node:test";
import assert from "node:assert/strict";

import { createOutgoingEchoGuard } from "../src/whatsapp/outgoingEchoGuard.js";
import { createCurrentWhatsappHarness } from "./helpers/createCurrentWhatsappHarness.js";

async function setup(t, { forwardFromMe }) {
  const harness = await createCurrentWhatsappHarness({ forwardFromMe });
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
  const userId = forwardFromMe ? "from-me-on" : "from-me-off";
  const row = await harness.repositoryStub.repository.ensureWhatsappSession(userId);
  row.bot_mode = "assist";
  row.bot_enabled_at = new Date(Date.now() - 120_000).toISOString();
  const session = await harness.whatsapp.startSession(row.id, { userId });
  const captured = [];
  harness.repositoryStub.repository.insertMessage = async (message) => {
    captured.push(message);
    return { id: captured.length, ...message };
  };
  async function emit(id, remoteJid, body, fromMe = true) {
    await session.socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: { id, remoteJid, fromMe },
        message: { conversation: body },
        messageTimestamp: Date.now(),
      }],
    });
  }
  return { harness, session, row, captured, emit };
}

test("N8N_FORWARD_FROM_ME=false keeps every outgoing message context-only, even a #rp-test", async (t) => {
  const { captured, emit } = await setup(t, { forwardFromMe: false });
  await emit("self", "123456789@lid", "Any trip £950");
  await emit("marked", "123456789@lid", "#rp-test\nLHR to Mayfair £950");
  await emit("outgoing", "447700900111@s.whatsapp.net", "Hi there");
  await emit("incoming", "447700900111@s.whatsapp.net", "New offer £950", false);
  assert.equal(captured.length, 4);
  assert.deepEqual(captured.map((row) => row.n8n_delivery_status), [
    null, null, null, "pending"
  ]);
  assert.deepEqual(captured.map((row) => row.processing_status), [
    "ignored", "ignored", "ignored", "new"
  ]);
});

test("N8N_FORWARD_FROM_ME=true sends manual outgoing self-chat and ordinary outbound messages without markers", async (t) => {
  const { captured, emit } = await setup(t, { forwardFromMe: true });
  await emit("self", "123456789@lid", "LHR to Mayfair £950");
  await emit("outbound", "447700900111@s.whatsapp.net", "Offer £220");
  await emit("incoming", "447700900111@s.whatsapp.net", "Incoming job £250", false);
  assert.equal(captured.length, 3);
  assert.deepEqual(captured.map((row) => row.n8n_delivery_status), [
    "pending", "pending", "pending"
  ]);
  assert.deepEqual(captured.map((row) => row.processing_status), [
    "new", "new", "new"
  ]);
  assert.deepEqual(captured.map((row) => row.from_me), [true, true, false]);
  assert.equal(captured[0].body, "LHR to Mayfair £950");
});

test("n8n /send-generated outgoing echoes are NOT queued even when forwarding fromMe is enabled", async (t) => {
  const { harness, session, captured, emit } = await setup(t, { forwardFromMe: true });
  session.status = "CONNECTED";
  const chatId = "447700900111@s.whatsapp.net";
  session.socket.sendMessage = async () => {
    // Baileys might echo before the send operation resolves.
    await emit("bot-id", chatId, "Automatic bot reply");
    return { key: { id: "bot-id" } };
  };

  const sent = await harness.whatsapp.sendText({
    sessionId: session.id,
    chatId,
    text: "Automatic bot reply",
  });
  assert.equal(sent.key.id, "bot-id");
  // It may also echo after sendMessage returns.
  await emit("bot-id", chatId, "Automatic bot reply");
  // A different message from the user is still forwarded.
  await emit("manual-id", chatId, "Offer from driver £100");

  assert.deepEqual(captured.map((row) => row.n8n_delivery_status), [
    null, null, "pending"
  ]);
  assert.deepEqual(captured.map((row) => row.processing_status), [
    "ignored", "ignored", "new"
  ]);
});

test("outgoing echo guard is keyed per session, handles overlapping sends and expires old ids", () => {
  let timestamp = 1000;
  const guard = createOutgoingEchoGuard({ now: () => timestamp, ttlMs: 100 });
  const first = guard.beginSend("s1", "chat1");
  const second = guard.beginSend("s1", "chat1");
  assert.equal(guard.shouldSuppress("s1", "chat1", "unknown"), true);
  assert.equal(guard.shouldSuppress("s2", "chat1", "unknown"), false);
  first("wa1");
  assert.equal(guard.shouldSuppress("s1", "chat1", "other"), true);
  second("wa2");
  assert.equal(guard.shouldSuppress("s1", "chat1", "other"), false);
  assert.equal(guard.shouldSuppress("s1", "different-chat", "wa1"), true);
  timestamp += 101;
  assert.equal(guard.shouldSuppress("s1", "chat1", "wa1"), false);
});
