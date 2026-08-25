import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const migrationPath =
  "supabase/migrations/20260825_dedupe_identical_sender_messages.sql";

test("sender content dedupe is bounded, cross-chat, and race-safe", async () => {
  const sql = await fs.readFile(migrationPath, "utf8");

  assert.match(sql, /same RidePicker session \+ same sender_id \+ same normalized text body/i);
  assert.match(sql, /interval '6 hours'/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /existing\.session_id = NEW\.session_id/i);
  assert.match(sql, /existing\.sender_id = NEW\.sender_id/i);
  assert.match(sql, /normalize_message_dedupe_body\(existing\.body\) = normalized_body/i);
  assert.match(sql, /RETURN NULL;/i);

  // Cross-posting the same text into another group should still dedupe, so the
  // duplicate lookup must not be scoped to chat_id.
  assert.doesNotMatch(sql, /existing\.chat_id\s*=\s*NEW\.chat_id/i);
});

test("sender content dedupe preserves outgoing/media messages and WhatsApp auth", async () => {
  const sql = await fs.readFile(migrationPath, "utf8");

  assert.match(sql, /COALESCE\(NEW\.from_me, false\)/i);
  assert.match(sql, /COALESCE\(NEW\.has_media, false\)/i);
  assert.match(sql, /BEFORE INSERT ON public\.messages/i);

  assert.doesNotMatch(
    sql,
    /\b(?:UPDATE|DELETE|INSERT INTO)\s+public\.whatsapp_(?:sessions|auth)\b/i
  );
  assert.doesNotMatch(sql, /\.logout\s*\(/i);
});
