-- Harden exposed database objects flagged by the Supabase security advisor.
-- Applied to the RidePicker production Supabase project on 2026-08-23.

alter view public.dashboard_summary set (security_invoker = true);

alter function public.set_updated_at() set search_path = pg_catalog, public;
alter function public.sync_bot_enabled_at() set search_path = pg_catalog, public;
alter function public.validate_message_tracking() set search_path = pg_catalog, public;

revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
