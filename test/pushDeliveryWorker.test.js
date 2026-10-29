import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createPushDeliveryWorker, nextPushDeliveryState } from "../src/pushDeliveryWorker.js";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privateKey.export({ format: "jwk" });
const config = {
  publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url"),
  privateKey: jwk.d, subject: "mailto:push@example.com",
};
const row = { id: 7, alert_id: 42, subscription_id: 5, user_id: "owner", attempt_count: 1 };
function testWorker({ send, alertStatus = "pending", older = 0, sub = true }) {
  const updates = [], removed = [], claims = [];
  const now = Date.now();
  const worker = createPushDeliveryWorker({
    config, workerId: "11111111-1111-4111-8111-111111111111",
    claim: async (opts) => { claims.push(opts); return [row]; },
    update: async (table, patch, query) => { updates.push({ table, patch, query }); return [row]; },
    remove: async (...args) => { removed.push(args); return []; },
    select: async (table) => table === "push_subscriptions"
      ? sub ? [{ id: 5, endpoint: "https://fcm.googleapis.com/fcm/send/test" }] : []
      : alertStatus === "pending"
        ? [{ id: 42, status: "pending", created_at: new Date(now - older).toISOString() }]
        : [],
    send, now: () => now, random: () => 0, logger: { warn() {}, info() {} },
  });
  return { worker, updates, removed, claims };
}

test("failed push delivery is persisted for retry with exponential backoff", async () => {
  const state = nextPushDeliveryState(1, "offline", null, 1_000, () => 0);
  assert.equal(state.status, "retry");
  assert.equal(state.next_attempt_at, new Date(3_000).toISOString());
  assert.equal(nextPushDeliveryState(8, "offline", null, 1_000, () => 0).status, "dead");
  const f = testWorker({ send: async () => 503 });
  await f.worker.processOnce();
  assert.equal(f.updates[0].patch.status, "retry");
  assert.equal(f.updates[0].query.locked_by, "eq." + f.worker.workerId);
  assert.equal(f.claims[0].p_batch_size, 10);
});

test("successful delivery acknowledges one outbox item", async () => {
  const f = testWorker({ send: async () => 201 });
  await f.worker.processOnce();
  assert.equal(f.updates[0].patch.status, "delivered");
  assert.ok(f.updates[0].patch.delivered_at);
});

test("expired push endpoint is deleted, and handled/stale alerts are skipped", async () => {
  const expired = testWorker({ send: async () => 410 });
  await expired.worker.processOnce();
  assert.equal(expired.removed.length, 1);
  const handled = testWorker({ send: async () => { throw Error("must not send"); }, alertStatus: "accepted" });
  await handled.worker.processOnce();
  assert.equal(handled.updates[0].patch.status, "skipped");
  const stale = testWorker({ send: async () => { throw Error("must not send"); }, older: 60 * 60_000 });
  await stale.worker.processOnce();
  assert.equal(stale.updates[0].patch.status, "skipped");
});
