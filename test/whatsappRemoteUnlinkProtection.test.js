import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const MIGRATION =
  "supabase/migrations/20260823_protect_whatsapp_remote_unlink.sql";
const LOCK_GUARD_MIGRATION =
  "supabase/migrations/20260823_lock_whatsapp_delete_guard_function.sql";
const FINAL_CLEANUP_MIGRATION =
  "supabase/migrations/20260823_finalize_whatsapp_auth_cleanup.sql";

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

test("delete guard trigger function is not exposed as a SECURITY DEFINER RPC", async () => {
  const sql = await fs.readFile(LOCK_GUARD_MIGRATION, "utf8");

  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION public\.prevent_whatsapp_session_delete_with_auth\(\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/i
  );
});

test("confirmed LOGGED_OUT transition purges every auth row for the session", async () => {
  const sql = await fs.readFile(FINAL_CLEANUP_MIGRATION, "utf8");

  assert.match(sql, /CREATE TRIGGER purge_whatsapp_auth_after_logged_out/i);
  assert.match(sql, /AFTER UPDATE OF status ON public\.whatsapp_sessions/i);
  assert.match(sql, /WHEN \(NEW\.status = 'LOGGED_OUT'\)/i);
  assert.match(
    sql,
    /DELETE FROM public\.whatsapp_auth\s+WHERE session_id = NEW\.id/i
  );
});

test("late auth writes cannot resurrect a LOGGED_OUT WhatsApp session", async () => {
  const sql = await fs.readFile(FINAL_CLEANUP_MIGRATION, "utf8");

  assert.match(sql, /CREATE TRIGGER discard_whatsapp_auth_for_logged_out_session/i);
  assert.match(sql, /BEFORE INSERT OR UPDATE ON public\.whatsapp_auth/i);
  assert.match(sql, /status = 'LOGGED_OUT'/i);
  assert.match(sql, /RETURN NULL/i);
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION public\.discard_whatsapp_auth_for_logged_out_session\(\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/i
  );
});

test("final cleanup migration never prunes active WhatsApp auth", async () => {
  const sql = await fs.readFile(FINAL_CLEANUP_MIGRATION, "utf8");
  const cleanupStatement = sql.match(
    /DELETE FROM public\.whatsapp_auth AS wa[\s\S]*?;/i
  )?.[0];

  assert.ok(cleanupStatement, "expected one-time auth residue cleanup");
  assert.match(cleanupStatement, /ws\.status = 'LOGGED_OUT'/i);
  assert.doesNotMatch(cleanupStatement, /CONNECTED|RECONNECTING|DISCONNECTED/i);
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
