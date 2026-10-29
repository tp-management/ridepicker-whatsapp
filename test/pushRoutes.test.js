import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createPushRouter } from "../src/pushRoutes.js";

const USER = "11111111-1111-4111-8111-111111111111";
const PHONE = "+37060000000";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/test";
const cfg = { publicKey: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 2)]).toString("base64url"), privateKey: Buffer.alloc(32, 1).toString("base64url"), subject: "mailto:push@example.com" };

async function fixture(t) {
  const inserts = [], removals = [], sent = [];
  const router = createPushRouter({
    findUser: async (id) => id === USER ? { id: USER, phone_e164: PHONE } : null,
    configured: () => true,
    pushConfig: () => cfg,
    authorize: async (user, authorization) => user.id === USER && authorization === "Bearer verified-otp-token",
    insert: async (...args) => { inserts.push(args); return []; },
    remove: async (...args) => { removals.push(args); return []; },
    startOtp: async (user) => { sent.push(user.phone_e164); },
    verifyOtp: async (_user, code) => code === "123456" ? "verified-otp-token" : Promise.reject(Error("invalid")),
    allowOtp: () => true,
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (suffix, method = "GET", body, token) => fetch(
    "http://127.0.0.1:" + server.address().port + suffix,
    {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { Authorization: "Bearer " + token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  return { request, inserts, removals, sent };
}

test("registration rejects missing/foreign bearer and only stores verified owner", async (t) => {
  const f = await fixture(t);
  const path = "/api/users/" + USER + "/push-subscriptions";
  assert.equal((await f.request(path, "POST", { endpoint: ENDPOINT })).status, 403);
  assert.equal((await f.request(path, "POST", { endpoint: ENDPOINT }, "wrong")).status, 403);
  assert.equal(f.inserts.length, 0);
  assert.equal((await f.request(path, "POST", { endpoint: ENDPOINT }, "verified-otp-token")).status, 201);
  assert.equal(f.inserts.length, 1);
  assert.equal(f.inserts[0][1][0].user_id, USER);
});

test("OTP verifies code then protects subscription deletion", async (t) => {
  const f = await fixture(t);
  const prefix = "/api/users/" + USER;
  assert.equal((await f.request(prefix + "/push-otp", "POST")).status, 202);
  assert.deepEqual(f.sent, [PHONE]);
  assert.equal((await f.request(prefix + "/push-otp/verify", "POST", { code: "222222" })).status, 401);
  const res = await f.request(prefix + "/push-otp/verify", "POST", { code: "123456" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { accessToken: "verified-otp-token" });
  assert.equal((await f.request(prefix + "/push-subscriptions", "DELETE", { endpoint: ENDPOINT })).status, 403);
  assert.equal((await f.request(prefix + "/push-subscriptions", "DELETE", { endpoint: ENDPOINT }, "verified-otp-token")).status, 200);
  assert.equal(f.removals.length, 1);
});
