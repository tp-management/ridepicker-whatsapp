import test from "node:test";
import assert from "node:assert/strict";

import { isMarkedSelfChatTestMessage } from "../src/whatsapp/selfChatTest.js";
import { createCurrentWhatsappHarness } from "./helpers/createCurrentWhatsappHarness.js";

const phone = "37061234567@s.whatsapp.net";
const lid = "123456789001234@lid";
const ownUser = { id: "37061234567:12@s.whatsapp.net", lid };

const classify = ({ remoteJid = phone, fromMe = true, body = "#rp-test\nLHR to Mayfair £950", user = ownUser, authMe = null, linkedPhone = null } = {}) =>
  isMarkedSelfChatTestMessage({
    messageKey: { remoteJid, fromMe },
    body,
    socketUser: user,
    authMe,
    linkedPhone,
  });

test("self-chat with #rp-test and real offer text is eligible, PN and LID", () => {
  assert.equal(classify(), true);
  assert.equal(classify({ remoteJid: lid }), true);
  assert.equal(classify({ remoteJid: "37061234567:5@s.whatsapp.net" }), true);
  assert.equal(classify({ body: "#RP-TEST: Today ASAP CM24 1QW £950" }), true);
  assert.equal(classify({ remoteJid: lid, user: null, authMe: { lid } }), true);
  assert.equal(classify({ user: null, linkedPhone: "+370 612 34567" }), true);
});

test("no normal outbound, unmarked self-chat, other user's LID or group reaches AI", () => {
  assert.equal(classify({ remoteJid: "447700900111@s.whatsapp.net" }), false);
  assert.equal(classify({ remoteJid: "998877660000@lid" }), false);
  assert.equal(classify({ remoteJid: "123@g.us" }), false);
  assert.equal(classify({ remoteJid: "status@broadcast" }), false);
  assert.equal(classify({ fromMe: false }), false);
  assert.equal(classify({ body: "CM24 1QW to KY16 £950" }), false);
  assert.equal(classify({ body: "#rp-test" }), false);
  assert.equal(classify({ body: "#rp-test:  " }), false);
  assert.equal(classify({ body: "#rp-testing CM24 to KY16" }), false);
  assert.equal(classify({ user: null, authMe: null, linkedPhone: null }), false);
});

test("actual Baileys notify handler queues ONLY a marked self-chat", async (t) => {
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

  const userId = "self-chat-test";
  const dbSession = await harness.repositoryStub.repository.ensureWhatsappSession(userId);
  dbSession.bot_mode = "assist";
  dbSession.bot_enabled_at = new Date(Date.now() - 120_000).toISOString();
  dbSession.whatsapp_phone = "+37061234567";
  const session = await harness.whatsapp.startSession(dbSession.id, { userId });
  session.socket.user = ownUser;
  const captured = [];
  harness.repositoryStub.repository.insertMessage = async (row) => {
    captured.push(row);
    return { id: captured.length, ...row };
  };

  const emit = async (id, remoteJid, body, fromMe = true) => {
    await session.socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: { id, remoteJid, fromMe },
        message: { conversation: body },
        messageTimestamp: Date.now(),
      }],
    });
  };

  await emit("self1", phone, "#rp-test\nLHR to Mayfair £950");
  await emit("self2", lid, "#rp-test\nCM24 1QW to KY16 £950");
  await emit("self3", phone, "ordinary saved self note");
  await emit("other1", "447700900111@s.whatsapp.net", "#rp-test\nprivate outgoing");
  await emit("incoming1", "447700900111@s.whatsapp.net", "Real incoming £950", false);

  assert.equal(captured.length, 5);
  assert.deepEqual(
    captured.map((row) => row.n8n_delivery_status),
    ["pending", "pending", null, null, "pending"]
  );
  assert.deepEqual(
    captured.map((row) => row.processing_status),
    ["new", "new", "ignored", "ignored", "new"]
  );
  assert.deepEqual(
    captured.map((row) => row.from_me),
    [true, true, true, true, false]
  );
  assert.equal(captured[0].body, "#rp-test\nLHR to Mayfair £950");
});
