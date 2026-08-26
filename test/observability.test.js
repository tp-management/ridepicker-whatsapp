import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { __observability } from "../src/observability.js";
import { __systemLog } from "../src/systemLog.js";

test("HTTP observability records shape without request body values", () => {
  assert.deepEqual(
    __observability.bodyShape({ password: "secret", mode: "assist", phone: "+37061234567" }),
    ["mode", "password", "phone"]
  );

  assert.equal(
    __observability.requestedUserId(
      "/api/users/339c3784-cd51-4eb0-b8b9-b561c01ba8bc/whatsapp"
    ),
    "339c3784-cd51-4eb0-b8b9-b561c01ba8bc"
  );
  assert.equal(
    __observability.requestedUserId("/api/users/not-a-uuid/whatsapp"),
    null
  );
});

test("HTTP request levels preserve signal", () => {
  assert.equal(
    __observability.requestLevel({
      method: "GET",
      statusCode: 200,
      durationMs: 12,
      path: "/api/users/x",
    }),
    "debug"
  );
  assert.equal(
    __observability.requestLevel({
      method: "PATCH",
      statusCode: 200,
      durationMs: 12,
      path: "/api/users/x",
    }),
    "info"
  );
  assert.equal(
    __observability.requestLevel({
      method: "GET",
      statusCode: 404,
      durationMs: 12,
      path: "/api/users/x",
    }),
    "warning"
  );
  assert.equal(
    __observability.requestLevel({
      method: "GET",
      statusCode: 500,
      durationMs: 12,
      path: "/api/users/x",
    }),
    "error"
  );
  assert.equal(
    __observability.requestLevel({
      method: "GET",
      statusCode: 200,
      durationMs: 2500,
      path: "/api/users/x",
    }),
    "warning"
  );
  assert.equal(
    __observability.isLongLivedPath(
      "/api/users/339c3784-cd51-4eb0-b8b9-b561c01ba8bc/events"
    ),
    true
  );
  assert.equal(
    __observability.requestLevel({
      method: "GET",
      statusCode: 200,
      durationMs: 60_000,
      path: "/api/users/339c3784-cd51-4eb0-b8b9-b561c01ba8bc/events",
    }),
    "debug"
  );
});

test("persistent log sanitizer removes credentials and direct WhatsApp identifiers", () => {
  const sanitized = __systemLog.sanitize({
    authorization: "Bearer super-secret-token",
    creds: { registered: true, key: "secret" },
    phone: "+37061234567",
    jid: "37061234567@s.whatsapp.net",
    url: "https://example.test/callback?token=abc123&ok=1",
    nested: {
      message: "contact +37061234567 at 37061234567@s.whatsapp.net",
    },
  });

  assert.equal(sanitized.authorization, "[redacted]");
  assert.equal(sanitized.creds, "[redacted]");
  assert.equal(sanitized.phone, "[redacted-phone]");
  assert.equal(sanitized.jid, "[redacted-jid]");
  assert.match(sanitized.url, /token=\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(sanitized), /37061234567/);
  assert.doesNotMatch(JSON.stringify(sanitized), /super-secret-token/);
});

test("actionability distinguishes expected failures, raw evidence, and real incidents", () => {
  assert.equal(
    __systemLog.classifyActionability("n8n", "n8n_failed", "error"),
    "expected"
  );
  assert.equal(
    __systemLog.classifyActionability("baileys_raw", "log", "error"),
    "attention"
  );
  assert.equal(
    __systemLog.classifyActionability("baileys_raw", "log", "warning"),
    "diagnostic"
  );
  assert.equal(
    __systemLog.classifyActionability(
      "ridepicker_whatsapp",
      "unexpected_401_relink_required",
      "warning"
    ),
    "actionable"
  );
  assert.equal(
    __systemLog.classifyActionability("http", "http_request_completed", "error"),
    "actionable"
  );
});

test("source keeps RidePicker WhatsApp lifecycle logs and instruments destructive auth operations", async () => {
  const [systemLogSource, authSource, appSource, runtimeSource] = await Promise.all([
    fs.readFile("src/systemLog.js", "utf8"),
    fs.readFile("src/whatsapp/auth/supabaseAuthStore.js", "utf8"),
    fs.readFile("src/app.js", "utf8"),
    fs.readFile("index.js", "utf8"),
  ]);

  assert.doesNotMatch(
    systemLogSource,
    /normalizedSource\s*===\s*["']ridepicker_whatsapp["'][\s\S]{0,100}return null/
  );
  assert.match(authSource, /whatsapp_auth_relink_clear_started/);
  assert.match(authSource, /whatsapp_auth_relink_clear_completed/);
  assert.match(authSource, /whatsapp_auth_clear_failed/);
  assert.match(appSource, /installRequestObservability/);
  assert.match(appSource, /logUnhandledHttpError/);
  assert.match(runtimeSource, /runtime_uncaught_exception/);
  assert.match(runtimeSource, /restart_recovery_completed/);
});
