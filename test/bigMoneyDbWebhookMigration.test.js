import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../supabase/migrations/20261030_big_money_db_triggered_push.sql", import.meta.url),
  "utf8"
);

test("BIG MONEY inserts trigger async HTTP without hardcoded hosting URLs", () => {
  assert.match(migration, /create extension if not exists pg_net/i);
  assert.match(migration, /after insert on public\.big_money_alerts/i);
  assert.match(migration, /when \(new\.status = 'pending'\)/i);
  assert.match(migration, /perform net\.http_post\(/);
  assert.match(migration, /url := webhook_url/);
  assert.doesNotMatch(migration, /https:\/\/ridepicker-whatsapp-production/);
});

test("BIG MONEY database callback uses both Vault configuration values and keeps new alerts", () => {
  assert.match(migration, /ridepicker_big_money_webhook_url/);
  assert.match(migration, /ridepicker_big_money_webhook_secret/);
  assert.match(migration, /webhook_url is null/i);
  assert.match(migration, /return new;/i);
  assert.match(migration, /set search_path = ''/);
  assert.equal((migration.match(/create trigger ridepicker_big_money_after_insert/gi) || []).length, 1);
  assert.equal((migration.match(/\$\$/g) || []).length, 2, "one PL/pgSQL function body");
});
