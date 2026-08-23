import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { classifyActivityKey } from "../src/activityRoutes.js";

test("activity ids classify explicit and synthetic message entries", () => {
  assert.deepEqual(classifyActivityKey("42"), {
    type: "activity",
    key: "42",
    id: "42",
  });
  assert.deepEqual(classifyActivityKey("activity:42"), {
    type: "activity",
    key: "activity:42",
    id: "42",
  });
  assert.deepEqual(classifyActivityKey("message:11"), {
    type: "message",
    key: "message:11",
    id: "11",
  });
  assert.throws(() => classifyActivityKey("message:nope"), /invalid activity id/);
});

test("message activity deletion preserves source messages with durable tombstones", async () => {
  const source = await fs.readFile("src/activityRoutes.js", "utf8");
  assert.match(source, /activity_dismissals/);
  assert.match(source, /sourcePreserved: true/);
  assert.doesNotMatch(source, /deleteRows\("messages"/);
  assert.match(source, /filter\(\(entry\) => !dismissed\.has\(String\(entry\.id\)\)\)/);
});

test("activity dismissal storage is server-only and durable", async () => {
  const sql = await fs.readFile(
    "supabase/migrations/20260823_activity_dismissals.sql",
    "utf8"
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.activity_dismissals/i);
  assert.match(sql, /PRIMARY KEY \(user_id, activity_key\)/i);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /GRANT SELECT, INSERT, DELETE ON TABLE public\.activity_dismissals TO service_role/i);
});
