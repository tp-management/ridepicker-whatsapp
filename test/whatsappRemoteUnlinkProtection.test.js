import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const MIGRATION =
  "supabase/migrations/20260823_protect_whatsapp_remote_unlink.sql";

test("database prevents session deletion from cascading away WhatsApp auth", async () => {
  const sql = await fs.readFile(MIGRATION, "utf8");

  assert.match(sql, /REFERENCES public\.whatsapp_sessions\(id\)\s+ON DELETE RESTRICT/i);
  assert.match(sql, /prevent_whatsapp_session_delete_with_auth/i);
  assert.match(sql, /REVOKE DELETE ON TABLE public\.whatsapp_auth FROM anon, authenticated, service_role/i);
  assert.match(sql, /REVOKE DELETE ON TABLE public\.whatsapp_sessions FROM anon, authenticated, service_role/i);
});

test("bulk auth clear refuses established linked-device auth before LOGGED_OUT", async () => {
  const sql = await fs.readFile(MIGRATION, "utf8");

  assert.match(sql, /ridepicker_whatsapp_auth_clear_safe/i);
  assert.match(sql, /session_connected_at IS NOT NULL/i);
  assert.match(sql, /session_status[^\n]*<> 'LOGGED_OUT'/i);
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION public\.ridepicker_whatsapp_auth_clear\([\s\S]*ridepicker_whatsapp_auth_clear_safe/i
  );
});

test("guarded user disconnect route is mounted before the legacy router", async () => {
  const [appSource, routerSource] = await Promise.all([
    fs.readFile("src/app.js", "utf8"),
    fs.readFile("src/whatsapp/managedDisconnectRouter.js", "utf8"),
  ]);

  const guardedIndex = appSource.indexOf("app.use(managedDisconnectRouter)");
  const legacyIndex = appSource.indexOf("app.use(router)");

  assert.ok(guardedIndex >= 0);
  assert.ok(legacyIndex > guardedIndex);
  assert.match(routerSource, /disconnectManagedSessionSafely/);
  assert.doesNotMatch(routerSource, /\bdisconnectManagedSession\s*\(/);
});
