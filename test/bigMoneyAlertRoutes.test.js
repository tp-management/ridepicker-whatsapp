import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createBigMoneyAlertRouter } from "../src/bigMoneyAlertRoutes.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TEXT = "🚕 Driver needed ASAP!\n  Airport → Centre\n£950\n\nSame-day payment\n";

async function fixture(t, { configured = true, internalKey = "test-secret" } = {}) {
  let nextId = 2;
  const alerts = [{
    id: 1,
    user_id: OWNER,
    source_message_id: null,
    original_message: "🧪 TEST ALERT",
    status: "pending",
    created_at: "2026-10-27T13:00:00Z",
  }];
  const notifications = [];
  const pushes = [];
  const calls = [];
  const services = {
    configured: () => configured,
    findUser: async (id) => [OWNER, OTHER].includes(id) ? { id } : null,
    internalKey,
    publish: (...args) => notifications.push(args),
    notify: async (userId) => pushes.push(userId),
    select: async (table, query) => {
      calls.push({ method: "select", table, query });
      if (table === "big_money_alerts") return alerts
        .filter((row) => row.user_id === query.user_id.slice(3) && row.status === query.status.slice(3))
        .sort((a, b) => a.id - b.id)
        .slice(0, query.limit);
      if (table === "whatsapp_sessions") {
        return query.user_id === "eq." + OWNER &&
          query.id === "eq.session-2" ? [{ id: "session-2" }] : [];
      }
      if (table === "messages") {
        if (query.id === "eq.42") return [{ id: 42, session_id: "session-2", body: TEXT }];
        if (query.id === "eq.77") return [{ id: 77, session_id: "other-users-session", body: TEXT }];
        return [];
      }
      throw Error("Unexpected table " + table);
    },
    update: async (table, patch, query) => {
      calls.push({ method: "update", table, patch, query });
      assert.equal(table, "big_money_alerts");
      const found = alerts.find((row) =>
        String(row.id) === query.id.slice(3) &&
        row.user_id === query.user_id.slice(3) &&
        row.status === query.status.slice(3));
      if (!found) return [];
      Object.assign(found, patch);
      return [found];
    },
    insert: async (table, records, options) => {
      calls.push({ method: "insert", table, records, options });
      assert.equal(table, "big_money_alerts");
      const data = records[0];
      const duplicate = alerts.some((row) =>
        row.user_id === data.user_id && row.source_message_id === data.source_message_id);
      if (duplicate) return [];
      const result = { id: nextId++, ...data, status: "pending", created_at: new Date().toISOString() };
      alerts.push(result);
      return [result];
    },
  };
  const app = express();
  app.use(express.json());
  app.use(createBigMoneyAlertRouter(services));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => new Promise((resolve, reject) =>
    server.close((err) => err ? reject(err) : resolve())));
  const root = "http://127.0.0.1:" + server.address().port;
  const request = (path, method = "GET", body, headers = {}) => fetch(root + path, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { alerts, notifications, pushes, calls, request };
}

test("GET lists only this user's pending alerts and preserves raw original body", async (t) => {
  const f = await fixture(t);
  const response = await f.request("/api/users/" + OWNER + "/big-money-alerts");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual((await response.json()).alerts, [{
    id: "1", messageId: null, originalMessage: "🧪 TEST ALERT", createdAt: "2026-10-27T13:00:00Z",
  }]);
  assert.deepEqual((await (await f.request("/api/users/" + OTHER + "/big-money-alerts")).json()).alerts, []);
  assert.equal((await f.request("/api/users/not-a-user/big-money-alerts")).status, 404);
});

test("internal queue requires key, verifies owning session, preserves raw body and ignores duplicates", async (t) => {
  const f = await fixture(t);
  const path = "/internal/big-money-alerts";
  const body = { userId: OWNER, messageId: 42, originalMessage: "FAKE TEXT MUST NOT BE USED" };
  assert.equal((await f.request(path, "POST", body)).status, 401);
  const headers = { "x-api-key": "test-secret" };
  const first = await f.request(path, "POST", body, headers);
  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), { ok: true, created: true });
  assert.equal(f.alerts[1].original_message, TEXT);
  assert.equal(f.notifications.length, 1);
  assert.deepEqual(f.pushes, [OWNER]);
  const duplicate = await f.request(path, "POST", body, headers);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { ok: true, created: false });
  assert.equal(f.alerts.length, 2);
  assert.equal(f.notifications.length, 1);
  assert.deepEqual(f.pushes, [OWNER], "Duplicate must not send another push");
  // Never leak messages from another user's WhatsApp session.
  assert.equal((await f.request(path, "POST", { userId: OTHER, messageId: 42 }, headers)).status, 404);
  assert.equal((await f.request(path, "POST", { userId: OWNER, messageId: 77 }, headers)).status, 404);
  assert.equal((await f.request(path, "POST", { userId: OWNER, messageId: 0 }, headers)).status, 400);
  assert.equal(f.alerts.length, 2, "Foreign session must not create a new alert");
});

test("DECLINE removes from pending only, preserves decision history; repeat is conflict", async (t) => {
  const f = await fixture(t);
  const path = "/api/users/" + OWNER + "/big-money-alerts/1";
  const result = await f.request(path, "PATCH", { decision: "decline" });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { alert: { id: "1", status: "declined" } });
  assert.equal(f.alerts[0].status, "declined");
  assert.ok(f.alerts[0].decided_at);
  const remaining = await f.request("/api/users/" + OWNER + "/big-money-alerts");
  assert.deepEqual((await remaining.json()).alerts, []);
  assert.equal((await f.request(path, "PATCH", { decision: "decline" })).status, 409);
});

test("ACCEPT records only accepted status, enforces ownership and validates decisions", async (t) => {
  const f = await fixture(t);
  const path = "/api/users/" + OWNER + "/big-money-alerts/1";
  assert.equal((await f.request(path, "PATCH", { decision: "maybe" })).status, 400);
  assert.equal((await f.request("/api/users/" + OTHER + "/big-money-alerts/1", "PATCH", { decision: "accept" })).status, 409);
  assert.equal((await f.request(path + "bad", "PATCH", { decision: "accept" })).status, 400);
  const response = await f.request(path, "PATCH", { decision: "accept" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { alert: { id: "1", status: "accepted" } });
  assert.equal(f.alerts[0].status, "accepted");
  assert.deepEqual(f.calls.filter((call) => call.method === "insert"), []);
  assert.equal(f.notifications.length, 0);
});

test("backend unconfigured rejects account reads", async (t) => {
  const f = await fixture(t, { configured: false });
  assert.equal((await f.request("/api/users/" + OWNER + "/big-money-alerts")).status, 503);
});
