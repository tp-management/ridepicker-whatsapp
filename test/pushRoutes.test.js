import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createPushRouter } from "../src/pushRoutes.js";

const pub = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 2)]).toString("base64url");
const cfg = { publicKey: pub, privateKey: Buffer.alloc(32, 1).toString("base64url"), subject: "mailto:test@example.com" };

test("push registration validates endpoint and known RidePicker user", async (t) => {
  const writes = [];
  const app = express();
  app.use(express.json());
  app.use(createPushRouter({
    configured: () => true,
    pushConfig: () => cfg,
    findUser: async (id) => id === "owner" ? { id } : null,
    insert: async (...args) => { writes.push(args); return []; },
  }));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = "http://127.0.0.1:" + server.address().port;
  const request = (user, endpoint) => fetch(root + "/api/users/" + user + "/push-subscriptions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
  const key = await fetch(root + "/api/push/public-key");
  assert.equal((await key.json()).publicKey, pub);
  assert.equal((await request("owner", "https://example.com/test")).status, 400);
  assert.equal((await request("other", "https://fcm.googleapis.com/fcm/send/test")).status, 404);
  assert.equal(writes.length, 0);
  assert.equal((await request("owner", "https://fcm.googleapis.com/fcm/send/test")).status, 201);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], "push_subscriptions");
  assert.equal(writes[0][1][0].user_id, "owner");
});
