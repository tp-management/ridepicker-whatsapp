import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  canonicalActivityKey,
  classifyActivityKey,
  normalizeActivityPriority,
} from "../src/activityRoutes.js";

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


test("activity priority is canonical and restricted to regular/high", () => {
  assert.equal(canonicalActivityKey("42"), "activity:42");
  assert.equal(canonicalActivityKey("activity:42"), "activity:42");
  assert.equal(canonicalActivityKey("message:11"), "message:11");
  assert.equal(normalizeActivityPriority("regular"), "regular");
  assert.equal(normalizeActivityPriority("HIGH"), "high");
  assert.throws(
    () => normalizeActivityPriority("urgent"),
    /priority must be regular or high/
  );
});

test("Activity priority storage covers real activity and synthetic messages", async () => {
  const source = await fs.readFile("src/activityRoutes.js", "utf8");
  const sql = await fs.readFile(
    "supabase/migrations/20261026_activity_priorities.sql",
    "utf8"
  );

  assert.match(source, /activity_priorities/);
  assert.match(source, /priority: priorities\.get\(canonicalActivityKey\(entry\.id\)\) \|\| "regular"/);
  assert.match(source, /router\.patch\(/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.activity_priorities/i);
  assert.match(sql, /priority text NOT NULL DEFAULT 'regular'/i);
  assert.match(sql, /priority IN \('regular', 'high'\)/i);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
});

test("Regular clears the stored override; Activity deletion cleans both entry types", async () => {
  const source = await fs.readFile("src/activityRoutes.js", "utf8");

  assert.match(source, /if \(priority === "regular"\) \{[\s\S]*?deleteActivityPriority\(userId, activityKey\)/);
  assert.match(source, /async function deleteActivityPriority\(userId, activityKey\) \{[\s\S]*?deleteRows\("activity_priorities"/);
  assert.equal(
    [...source.matchAll(/await deleteActivityPriority\(userId, target\.key\)/g)].length,
    2,
    "Both persisted Activity rows and synthetic message dismissals clear overrides"
  );
  assert.doesNotMatch(source, /deleteRows\("messages"/);
});
