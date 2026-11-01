import test from "node:test";
import assert from "node:assert/strict";
import { createCurrentWhatsappHarness } from "./helpers/createCurrentWhatsappHarness.js";

const SELF = "37061234567@s.whatsapp.net";
const OTHER = "447700900111@s.whatsapp.net";

async function runScenario(t, forwardFromMe) {
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
  const userId = "forward-from-me-test";
  const dbSession = await harness.repositoryStub.repository.ensureWhatsappSession(userId);
  dbSession.bot_mode = "assist";
  dbSession.bot_enabled_at = new Date(Date.now() - 120_000).toISOString();
  dbSession.whatsapp_phone = "+37061234567";
  const session = await harness.whatsapp.startSession(dbSession.id, { userId });
  const captured = [];
  harness.repositoryStub.repository.insertMessage = async (row) => {
    captured.push(row);
    return { id: captured.length, ...row };
  };
  const emit = async (id, remoteJid, body, fromMe) => {
    await session.socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: { id, remoteJid, fromMe },
        message: { conversation: body },
        messageTimestamp: Date.now(),
      }],
    });
  };

  await emit("self1", SELF, "LHR to Mayfair £950", true);
  await emit("self2", SELF, "#rp-test\nLHR to Mayfair £950", true);
  await emit("outgoing1", OTHER, "Normal outgoing response", true);
  await emit("incoming1", OTHER, "Incoming offer £950", false);

  assert.equal(captured.length, 4);
  const expected = forwardFromMe ?
    ["pending", "pending", "pending", "pending"] :
    [null, null, null, "pending"];
  assert.deepEqual(captured.map((row) => row.n8n_delivery_status), expected);
  assert.deepEqual(captured.map((row) => row.processing_status),
    expected.map((value) => value === "pending" ? "new" : "ignored"));
  assert.deepEqual(captured.map((row) => row.from_me), [true, true, true, false]);
  assert.equal(captured[0].body, "LHR to Mayfair £950");
  assert.equal(captured[1].body, "#rp-test\nLHR to Mayfair £950");
}

test("N8N_FORWARD_FROM_ME=false ignores ALL outgoing messages, including #rp-test", async (t) => {
  await runScenario(t, false);
});

test("N8N_FORWARD_FROM_ME=true queues ALL outgoing messages without needing #rp-test", async (t) => {
  await runScenario(t, true);
});
