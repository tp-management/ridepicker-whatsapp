import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("production entrypoint uses safe restart recovery, not legacy destructive restore", async () => {
  const source = await fs.readFile("index.js", "utf8");

  assert.match(source, /whatsapp\/restartRecovery\.js/);
  assert.match(source, /recoverManagedSessions/);
  assert.doesNotMatch(source, /\brestoreSessions\b/);
});

test("process shutdown closes sockets locally and never calls WhatsApp logout", async () => {
  const source = await fs.readFile("src/whatsapp/restartRecovery.js", "utf8");
  const shutdown = source.split("export async function shutdownManagedSessions()")[1];

  assert.ok(shutdown, "expected shutdownManagedSessions implementation");
  assert.match(shutdown, /socket\?\.end\?/);
  assert.doesNotMatch(shutdown, /socket\?*\.logout\s*\(/);
  assert.doesNotMatch(shutdown, /clearSupabaseAuthState\s*\(/);
});

test("ordinary terminal reconciliation cannot invoke remote unlink", async () => {
  const source = await fs.readFile("src/whatsapp/managedSessionBoundary.js", "utf8");
  const reconcile = source
    .split("async function reconcileTerminalSession(userId)")[1]
    ?.split("async function disconnectManagedSessionSafely(userId)")[0];

  assert.ok(reconcile, "expected reconciliation implementation");
  assert.doesNotMatch(reconcile, /remoteLogoutAndFinalize\s*\(/);
  assert.doesNotMatch(reconcile, /\.logout\s*\(/);
  assert.match(reconcile, /startSessionAdapter/);
});

test("readiness health router is mounted before application routes", async () => {
  const source = await fs.readFile("src/app.js", "utf8");
  const health = source.indexOf("app.use(healthRouter)");
  const managed = source.indexOf("app.use(managedDisconnectRouter)");
  const legacy = source.indexOf("app.use(router)");

  assert.ok(health >= 0);
  assert.ok(managed > health);
  assert.ok(legacy > managed);
});

test("legacy DELETE is fail-closed and durable sessions use guarded disconnect", async () => {
  const source = await fs.readFile(
    "src/whatsapp/managedDisconnectRouter.js",
    "utf8"
  );
  const legacyDelete = source.split('router.delete(\n  "/sessions/:id"')[1];

  assert.ok(legacyDelete, "expected intercepted legacy DELETE route");
  assert.match(legacyDelete, /requireInternalKey/);
  assert.match(legacyDelete, /getWhatsappSessionById/);
  assert.match(legacyDelete, /disconnectManagedSessionSafely\(dbSession\.user_id\)/);
  assert.match(legacyDelete, /requestRemoteLogout:\s*linkedRuntime/);
  assert.match(legacyDelete, /no credentials were removed/);
  assert.doesNotMatch(legacyDelete, /return next\(\)/);
});
