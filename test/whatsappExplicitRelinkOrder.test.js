import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("explicit relink deletes quarantined old auth before any new pairing socket starts", async () => {
  const source = await fs.readFile("src/whatsapp.js", "utf8");

  const prepare = sliceBetween(
    source,
    "async function prepareExplicitRelink(dbSession)",
    "export async function startManagedSession"
  );
  assert.match(prepare, /dbSession\.recovery_state !== \"relink_required\"/);
  assert.match(prepare, /await clearSupabaseAuthStateForRelink\(dbSession\.id\)/);

  const pairing = sliceBetween(
    source,
    "export async function requestManagedPairingCode",
    "export async function refreshManagedQr"
  );
  const pairingPrepare = pairing.indexOf("await prepareExplicitRelink(dbSession)");
  const pairingStart = pairing.indexOf("await startSession(");
  assert.ok(pairingPrepare >= 0, "pairing flow must prepare explicit relink");
  assert.ok(pairingStart > pairingPrepare, "old auth must be cleared before a new pairing socket starts");

  const qr = sliceBetween(
    source,
    "export async function refreshManagedQr",
    "export async function retryManagedSession"
  );
  const qrPrepare = qr.indexOf("await prepareExplicitRelink(dbSession)");
  const qrStart = qr.indexOf("await startSession(");
  assert.ok(qrPrepare >= 0, "QR relink flow must prepare explicit relink");
  assert.ok(qrStart > qrPrepare, "old auth must be cleared before a new QR socket starts");

  const retry = sliceBetween(
    source,
    "export async function retryManagedSession",
    "export async function requestRemoteLogoutForSession"
  );
  assert.match(retry, /dbSession\.recovery_state === \"relink_required\"/);
  assert.match(retry, /error\.details = \{ code: \"RELINK_REQUIRED\" \}/);
});

test("relink auth clear is serialized with pending auth mutations", async () => {
  const source = await fs.readFile(
    "src/whatsapp/auth/supabaseAuthStore.js",
    "utf8"
  );

  const clearForRelink = sliceBetween(
    source,
    "async function clearForRelink(sessionId)",
    "async function has(sessionId)"
  );

  assert.match(clearForRelink, /await enqueue\(sessionId/);
  assert.match(clearForRelink, /rpc\/ridepicker_whatsapp_auth_prepare_relink/);
});
