import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("quiet-account 401 stability proof is durable and generation-based", async () => {
  const sql = await fs.readFile(
    "supabase/migrations/20260826_make_401_stability_restart_safe.sql",
    "utf8"
  );

  assert.match(sql, /FOR UPDATE/i);
  assert.match(sql, /v_status\s*=\s*'CONNECTED'/i);
  assert.match(sql, /v_connected_at\s+IS NOT NULL/i);
  assert.match(sql, /v_now\s*-\s*v_connected_at\s*>=\s*interval\s*'5 minutes'/i);
  assert.match(sql, /v_attempt_count\s*:=\s*0/i);
  assert.doesNotMatch(sql, /status\s*=\s*'LOGGED_OUT'/i);
});
