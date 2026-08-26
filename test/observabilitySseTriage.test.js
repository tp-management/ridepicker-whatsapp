import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("normal SSE client disconnects stay diagnostic", async () => {
  const source = await fs.readFile("src/observability.js", "utf8");
  assert.match(source, /streamAbort \? "debug" : "warning"/);
  assert.match(source, /streamAbort \? "http_stream_aborted" : "http_request_aborted"/);
  assert.match(source, /streamAbort \? "diagnostic" : "attention"/);
});

test("incident views exclude SSE lifecycle and expected n8n failures", async () => {
  const sql = await fs.readFile(
    "supabase/migrations/20260826_refine_http_stream_triage.sql",
    "utf8"
  );

  assert.match(sql, /http_stream_aborted/);
  assert.match(sql, /http_stream_closed/);
  assert.match(sql, /then 'diagnostic'/i);
  assert.match(sql, /source = 'n8n' and event = 'n8n_failed' then 'expected'/i);
  assert.match(sql, /create or replace view public\.system_log_incidents_v1/i);
  assert.match(sql, /where actionability = 'actionable'/i);
  assert.match(sql, /grant select on public\.system_log_incidents_v1[\s\S]*to service_role/i);
});
