-- Trigger functions do not need to be callable through PostgREST. Keep the
-- delete guard internal so anon/authenticated/service-role clients cannot invoke
-- this SECURITY DEFINER function directly as an RPC.
REVOKE ALL ON FUNCTION public.prevent_whatsapp_session_delete_with_auth()
  FROM PUBLIC, anon, authenticated, service_role;
