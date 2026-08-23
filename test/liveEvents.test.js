import assert from "node:assert/strict";
import test from "node:test";

import {
  publishUserChange,
  scopesForUserWrite,
  subscribeUserChanges,
} from "../src/liveEvents.js";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("push events batch nearby invalidations for one user", async () => {
  const events = [];
  const unsubscribe = subscribeUserChanges("user-a", (event) => events.push(event));

  publishUserChange("user-a", ["whatsapp"], "state");
  publishUserChange("user-a", ["activity", "whatsapp"], "activity");
  publishUserChange("user-b", ["jobs"], "other-user");

  await wait(60);
  unsubscribe();

  assert.equal(events.length, 1);
  assert.deepEqual(new Set(events[0].scopes), new Set(["whatsapp", "activity"]));
  assert.equal(events[0].type, "invalidate");
});

test("user write paths map to narrow refresh scopes", () => {
  assert.deepEqual(scopesForUserWrite("/api/users/u/jobs/j/status"), [
    "jobs",
    "activity",
  ]);
  assert.deepEqual(scopesForUserWrite("/api/users/u/assist-preferences"), [
    "assist",
  ]);
  assert.deepEqual(scopesForUserWrite("/api/users/u/whatsapp"), [
    "whatsapp",
    "activity",
    "ridepicker",
  ]);
  assert.deepEqual(scopesForUserWrite("/api/users/u/profile"), ["profile"]);
});
