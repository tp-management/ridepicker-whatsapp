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

test("minimum price detection scans numeric values without requiring price keywords", async () => {
  const priceSql = await fs.readFile(
    "supabase/migrations/20260825_assist_price_any_numeric_value.sql",
    "utf8"
  );

  assert.match(priceSql, /dp\.minimum_job_price/i);
  assert.match(priceSql, /minimum_job_price IS NULL OR minimum_job_price <= 0/i);
  assert.match(priceSql, /regexp_matches\([\s\S]*\[0-9\]\+/i);
  assert.match(priceSql, /number_value >= minimum_job_price/i);
  assert.match(priceSql, /numeric_value_found/i);
  assert.match(priceSql, /No fare\/net\/GBP\/£ keyword is[\s\S]*required for a number/i);
  assert.ok(
    priceSql.includes("'[0-9]{1,2}[/-][0-9]{1,2}(?:[/-][0-9]{2,4})?'")
  );
  assert.ok(priceSql.includes("'[0-2]?[0-9]:[0-5][0-9]'"));
  assert.match(priceSql, /BETWEEN 1900 AND 2100/i);

  // Price filtering stays inside the messages BEFORE INSERT concern only.
  // It must never mutate durable WhatsApp session/auth state or perform logout.
  assert.doesNotMatch(
    priceSql,
    /\b(?:UPDATE|DELETE|INSERT INTO)\s+public\.whatsapp_(?:sessions|auth)\b/i
  );
  assert.doesNotMatch(priceSql, /\.logout\s*\(/i);
});

test("Assist preferences API only allows writes while WhatsApp is connected", async () => {
  const source = await fs.readFile("src/assistPreferencesRoutes.js", "utf8");
  assert.match(source, /session\.status !== "CONNECTED"/);
  assert.match(source, /sanitizeAssistKeywords\(req\.body\?\.keywords\)/);
  assert.match(source, /assist_keywords: keywords/);
});
