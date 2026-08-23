import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  MAX_ASSIST_KEYWORDS,
  messageMatchesAssistKeywords,
  normalizeAssistText,
  sanitizeAssistKeywords,
} from "../src/assistPreferences.js";

test("Assist keyword matching is case-insensitive substring matching", () => {
  assert.equal(messageMatchesAssistKeywords("Pickup at xxLHR123xx", ["lhr"]), true);
  assert.equal(messageMatchesAssistKeywords("Pickup at Heathrow", ["LHR"]), false);
});

test("Assist keyword matching normalizes Unicode, whitespace, and zero-width characters", () => {
  assert.equal(normalizeAssistText("  ＬＨＲ\u200b\n pickup  "), "lhr pickup");
  assert.equal(
    messageMatchesAssistKeywords("Airport\n\ttransfer available", ["airport transfer"]),
    true
  );
});

test("empty keyword list processes all messages while configured keywords require text", () => {
  assert.equal(messageMatchesAssistKeywords("anything", []), true);
  assert.equal(messageMatchesAssistKeywords("", ["lhr"]), false);
});

test("Assist keyword sanitizer trims, deduplicates, and enforces limits", () => {
  assert.deepEqual(sanitizeAssistKeywords(["  LHR  ", "lhr", "Airport\ntransfer"]), [
    "LHR",
    "Airport transfer",
  ]);

  assert.throws(() => sanitizeAssistKeywords("lhr"), /keywords must be an array/);
  assert.throws(
    () => sanitizeAssistKeywords(Array.from({ length: MAX_ASSIST_KEYWORDS + 1 }, (_, i) => `k${i}`)),
    /maximum/i
  );
});

test("database trigger strictly skips unmatched rows regardless of message direction", async () => {
  const initialSql = await fs.readFile(
    "supabase/migrations/20260823_add_assist_keyword_filter.sql",
    "utf8"
  );
  const strictSql = await fs.readFile(
    "supabase/migrations/20260823_strict_assist_keyword_storage_filter.sql",
    "utf8"
  );

  assert.match(initialSql, /ADD COLUMN IF NOT EXISTS assist_keywords text\[\]/i);
  assert.match(initialSql, /BEFORE INSERT ON public\.messages/i);
  assert.doesNotMatch(strictSql, /IF COALESCE\(NEW\.from_me, false\)/i);
  assert.match(strictSql, /position\(normalized_keyword IN normalized_body\) > 0/i);
  assert.match(strictSql, /unmatched messages never enter messages/i);
  assert.match(strictSql, /RETURN NULL/i);
});

test("Assist preferences API only allows writes while WhatsApp is connected", async () => {
  const source = await fs.readFile("src/assistPreferencesRoutes.js", "utf8");
  assert.match(source, /session\.status !== "CONNECTED"/);
  assert.match(source, /sanitizeAssistKeywords\(req\.body\?\.keywords\)/);
  assert.match(source, /assist_keywords: keywords/);
});
