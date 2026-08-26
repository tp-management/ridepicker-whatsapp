import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("WhatsApp Activity dedupe keeps INSERT return semantics", async () => {
  const sql = await fs.readFile(
    "supabase/migrations/20260826_activity_whatsapp_lifecycle_after_insert.sql",
    "utf8"
  );

  assert.match(sql, /security definer/i);
  assert.match(sql, /a\.id <> new\.id/i);
  assert.match(sql, /delete from public\.activity[\s\S]*where id = new\.id/i);
  assert.match(sql, /after insert on public\.activity/i);
  assert.doesNotMatch(sql, /return null/i);
});
