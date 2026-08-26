import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("WhatsApp Activity keeps semantic state transitions and serializes duplicates", async () => {
  const sql = await fs.readFile(
    "supabase/migrations/20260826_activity_whatsapp_lifecycle_dedupe.sql",
    "utf8"
  );

  assert.match(sql, /new\.type <> 'whatsapp'/i);
  assert.match(
    sql,
    /new\.title not in \('WhatsApp connected', 'WhatsApp disconnected'\)/i
  );
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /if v_previous_title = new\.title then[\s\S]*return null/i);
  assert.match(sql, /lag\(title\)[\s\S]*partition by user_id/i);
  assert.match(sql, /before insert on public\.activity/i);
});
