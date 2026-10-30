import test from "node:test";
import assert from "node:assert/strict";
import { processBigMoneyPushActions, createBigMoneyPushWorker, BIG_MONEY_MAX_PUSHES, BIG_MONEY_PUSH_INTERVAL_MS } from "../src/bigMoneyPushWorker.js";

const USER = "11111111-1111-4111-8111-111111111111";

function fixture() {
  let now = 0;
  const row = { id: 42, user_id: USER, status: "pending", push_attempts: 0, next_push_at: 0, decided_at: null };
  const sends = [];
  const events = [];
  const claim = async ({ p_alert_id }) => {
    if (p_alert_id != null && p_alert_id !== row.id) return [];
    if (row.status !== "pending" || row.next_push_at == null || now < row.next_push_at) return [];
    if (row.push_attempts >= BIG_MONEY_MAX_PUSHES) {
      row.status = "ignored";
      row.decided_at = now;
      row.next_push_at = null;
      return [{ alert_id: row.id, user_id: row.user_id, action: "ignored", attempt_number: 10 }];
    }
    row.push_attempts += 1;
    row.next_push_at = now + BIG_MONEY_PUSH_INTERVAL_MS;
    return [{ alert_id: row.id, user_id: row.user_id, action: "send", attempt_number: row.push_attempts }];
  };
  const process = () => processBigMoneyPushActions({
    claim,
    notify: async (userId) => { sends.push({ userId, now }); return { sent: 1 }; },
    publish: (user, scopes, event) => events.push({ user, scopes, event }),
    logger: { info() {}, warn() {} },
  });
  return { row, sends, events, claim, process, setNow: (value) => { now = value; } };
}

test("sends exactly 10 notifications, 30 seconds apart, then marks ignored at 5 minutes", async () => {
  const f = fixture();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    f.setNow(attempt * 30_000);
    await f.process();
    assert.equal(f.row.push_attempts, attempt + 1);
    assert.equal(f.sends.length, attempt + 1);
    assert.equal(f.row.status, "pending");
    await f.process(); // Duplicate webhook / concurrent polling must not send again.
    assert.equal(f.sends.length, attempt + 1);
  }
  f.setNow(299_999);
  await f.process();
  assert.equal(f.row.status, "pending");
  f.setNow(300_000);
  await f.process();
  assert.equal(f.row.status, "ignored");
  assert.equal(f.sends.length, 10);
  assert.equal(f.row.decided_at, 300_000);
  assert.equal(f.events.filter((e) => e.event === "big_money_alert_ignored").length, 1);
  f.setNow(330_000);
  await f.process();
  assert.equal(f.sends.length, 10);
});

test("accept/decline cancels all future notifications", async () => {
  for (const status of ["accepted", "declined"]) {
    const f = fixture();
    await f.process();
    assert.equal(f.sends.length, 1);
    f.row.status = status;
    f.setNow(30_000);
    await f.process();
    f.setNow(300_000);
    await f.process();
    assert.equal(f.row.status, status);
    assert.equal(f.sends.length, 1);
  }
});

test("worker skips overlapping polls and recovers after errors", async () => {
  let resolve;
  let started = 0;
  const logger = { error() {} };
  const worker = createBigMoneyPushWorker({
    logger,
    process: async () => {
      started++;
      if (started === 1) await new Promise((r) => { resolve = r; });
      else if (started === 2) throw new Error("temporary failure");
      return { claimed: 0 };
    },
  });
  const first = worker.processOnce();
  assert.deepEqual(await worker.processOnce(), { claimed: 0 });
  assert.equal(started, 1);
  resolve();
  await first;
  assert.deepEqual(await worker.processOnce(), { claimed: 0, error: true });
  await worker.processOnce();
  assert.equal(started, 3);
});
