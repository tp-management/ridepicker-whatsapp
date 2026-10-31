import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import express from "express";
import { historyMessageToApi, requestOnDemandHistory } from "../src/whatsapp/onDemandHistory.js";
import { createWhatsappHistoryRouter } from "../src/whatsapp/historyRouter.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const CHAT = "37060012345@s.whatsapp.net";
const KEY = "test-secret";

function fakeSocket({ emit = true, early = false } = {}) {
  const ev = new EventEmitter();
  const calls = [];
  const sock = {
    ev,
    async fetchMessageHistory(...args) {
      calls.push(args);
      const event = {
        peerDataRequestSessionId: "req-123",
        messages: [
          { key: { id: "old-1", remoteJid: CHAT, fromMe: false },
            messageTimestamp: 1760000000, message: { conversation: "Hello" } },
          { key: { id: "not-owned", remoteJid: "999@s.whatsapp.net", fromMe: false },
            messageTimestamp: 1760000001, message: { conversation: "PRIVATE" } },
        ],
      };
      if (emit) {
        if (early) ev.emit("messaging-history.set", event);
        else setImmediate(() => ev.emit("messaging-history.set", event));
      }
      return "req-123";
    },
  };
  return { sock, calls };
}

test("returns ONLY requested chat history, with a cursor and no DB writes", async () => {
  const f = fakeSocket();
  const data = await requestOnDemandHistory(f.sock, {
    chatId: CHAT, oldestKey: { id: "anchor", remoteJid: CHAT, fromMe: false },
    oldestTimestampMs: 1760000100000,
  });
  assert.equal(data.status, "received");
  assert.equal(data.messages.length, 1);
  assert.equal(data.messages[0].text, "Hello");
  assert.equal(data.messages[0].timestamp, "2025-10-09T08:53:20.000Z");
  assert.equal(data.messages[0].id, "old-1");
  assert.equal(data.nextBefore.id, "old-1");
  assert.equal(data.complete, false);
  assert.equal(f.calls[0][0], 50);
  assert.equal(f.calls[0][2], 1760000100000);
  assert.equal(f.sock.ev.listenerCount("messaging-history.set"), 0);
});

test("handles a response arriving before the request ID resolves", async () => {
  const f = fakeSocket({ early: true });
  const data = await requestOnDemandHistory(f.sock, {
    chatId: CHAT, oldestKey: { id: "anchor", remoteJid: CHAT }, oldestTimestampMs: 1760000100000,
  });
  assert.equal(data.messages.length, 1);
});

test("returns an explicit timeout rather than an empty history when WhatsApp is silent", async () => {
  const f = fakeSocket({ emit: false });
  await assert.rejects(requestOnDemandHistory(f.sock, {
    chatId: CHAT, oldestKey: { id: "anchor", remoteJid: CHAT }, oldestTimestampMs: 1760000100000,
    timeoutMs: 10,
  }), (e) => e.status === 504);
  assert.equal(f.sock.ev.listenerCount("messaging-history.set"), 0);
});

test("rejects overlapping history requests on the same socket", async () => {
  const f = fakeSocket({ emit: false });
  const p = requestOnDemandHistory(f.sock, {
    chatId: CHAT, oldestKey: { id: "anchor", remoteJid: CHAT }, oldestTimestampMs: 1760000100000,
    timeoutMs: 20,
  });
  await assert.rejects(requestOnDemandHistory(f.sock, {
    chatId: CHAT, oldestKey: { id: "anchor", remoteJid: CHAT }, oldestTimestampMs: 1760000100000,
    timeoutMs: 20,
  }), (e) => e.status === 409);
  await assert.rejects(p, (e) => e.status === 504);
});

test("formats wrapped messages without exposing message protocol internals", () => {
  const result = historyMessageToApi({
    key: { id: "x", remoteJid: CHAT, fromMe: true },
    messageTimestamp: 1760000000,
    message: { ephemeralMessage: { message: { extendedTextMessage: { text: "Private offer" } } } },
  });
  assert.equal(result.text, "Private offer");
  assert.equal(result.fromMe, true);
  assert.equal(result.timestampMs, 1760000000000);
});

async function routeFixture(t, overrides = {}) {
  const calls = [];
  const socket = {};
  const app = express();
  app.use(express.json());
  app.use(createWhatsappHistoryRouter({
    apiKey: KEY,
    findSession: async () => ({ id: SESSION, user_id: OWNER }),
    lookupAnchor: async (query) => {
      calls.push(query);
      return [{ whatsapp_message_id: "anchor", message_timestamp: "2026-10-01T12:00:00Z",
        from_me: false, sender_id: CHAT }];
    },
    getSocketSession: () => ({ status: "CONNECTED", socket }),
    requestHistory: async (_socket, args) => {
      calls.push(args);
      return { status: "received", messages: [{ id: "old", text: "Hi" }], nextBefore: null, complete: false };
    },
    ...overrides,
  }));
  const server = await new Promise(resolve => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = (body, key = KEY) => fetch("http://127.0.0.1:" + server.address().port
    + "/internal/whatsapp/history", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
  });
  return { calls, post };
}

test("route checks caller and connected session; locates existing anchor without saving history", async t => {
  const f = await routeFixture(t);
  const input = { userId: OWNER, sessionId: SESSION, chatId: CHAT };
  assert.equal((await f.post(input, "wrong")).status, 401);
  assert.equal((await f.post({ ...input, chatId: "invalid" })).status, 400);
  const result = await f.post(input);
  assert.equal(result.status, 200);
  const data = await result.json();
  assert.equal(data.messages.length, 1);
  assert.equal(data.complete, false);
  assert.equal(f.calls[0].select, "whatsapp_message_id,message_timestamp,from_me,sender_id");
  assert.equal(f.calls[1].oldestKey.id, "anchor");
  assert.equal(f.calls[1].oldestTimestampMs, Date.parse("2026-10-01T12:00:00Z"));
});

test("route accepts a supplied cursor to fetch an older page", async t => {
  const f = await routeFixture(t);
  const result = await f.post({
    userId: OWNER, sessionId: SESSION, chatId: CHAT,
    before: { id: "prev", timestampMs: 1760000100000, fromMe: true }, count: 10,
  });
  assert.equal(result.status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].oldestKey.id, "prev");
  assert.equal(f.calls[0].count, 10);
});

test("route refuses a session belonging to a different owner", async t => {
  const f = await routeFixture(t, { findSession: async () => ({ user_id: "other" }) });
  assert.equal((await f.post({ userId: OWNER, sessionId: SESSION, chatId: CHAT })).status, 404);
  assert.equal(f.calls.length, 0);
});

test("route tells n8n when chat has no message anchor", async t => {
  const f = await routeFixture(t, { lookupAnchor: async () => [] });
  const result = await f.post({ userId: OWNER, sessionId: SESSION, chatId: CHAT });
  assert.equal(result.status, 422);
  assert.match((await result.json()).error, /chatId alone/);
});

test("route requires a configured secret", async t => {
  const f = await routeFixture(t, { apiKey: "" });
  assert.equal((await f.post({ userId: OWNER, sessionId: SESSION, chatId: CHAT })).status, 503);
});
