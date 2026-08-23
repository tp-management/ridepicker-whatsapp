-- Preserve recoverable Baileys auth until a linked WhatsApp device has been
-- remotely unlinked. App/runtime code must never destroy established auth just
-- because a database row was manually marked DISCONNECTED or a process died.

ALTER TABLE public.whatsapp_auth
  DROP CONSTRAINT IF EXISTS whatsapp_auth_session_id_fkey;

ALTER TABLE public.whatsapp_auth
  ADD CONSTRAINT whatsapp_auth_session_id_fkey
  FOREIGN KEY (session_id)
  REFERENCES public.whatsapp_sessions(id)
  ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION public.ridepicker_whatsapp_auth_clear_safe(
  p_session_id uuid,
  p_auth_type text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  session_status text;
  session_connected_at timestamptz;
BEGIN
  SELECT status, connected_at
  INTO session_status, session_connected_at
  FROM public.whatsapp_sessions
  WHERE id = p_session_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- connected_at is durable proof that this auth state has represented a real
  -- linked device. Until WhatsApp has been moved to LOGGED_OUT, preserve that
  -- auth so the backend can still authenticate and retry socket.logout().
  IF session_connected_at IS NOT NULL
     AND COALESCE(session_status, '') <> 'LOGGED_OUT' THEN
    RETURN false;
  END IF;

  DELETE FROM public.whatsapp_auth
  WHERE session_id = p_session_id
    AND (p_auth_type IS NULL OR auth_type = p_auth_type);

  RETURN true;
END;
$$;

-- Keep the existing RPC signature for deployed callers, but route every bulk
-- clear through the guarded function above. Per-key Signal-key rotation still
-- happens through ridepicker_whatsapp_auth_write() and is intentionally not
-- affected by this protection.
CREATE OR REPLACE FUNCTION public.ridepicker_whatsapp_auth_clear(
  p_session_id uuid,
  p_auth_type text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.ridepicker_whatsapp_auth_clear_safe(
    p_session_id,
    p_auth_type
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ridepicker_whatsapp_auth_clear_safe(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ridepicker_whatsapp_auth_clear_safe(uuid, text)
  TO service_role;

-- The backend uses SECURITY DEFINER RPCs for auth mutation. Removing direct
-- service-role DELETE prevents an ordinary PostgREST/service-role request from
-- bypassing the remote-unlink workflow.
REVOKE DELETE ON TABLE public.whatsapp_auth FROM anon, authenticated, service_role;
REVOKE DELETE ON TABLE public.whatsapp_sessions FROM anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.prevent_whatsapp_session_delete_with_auth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.whatsapp_auth
    WHERE session_id = OLD.id
  ) THEN
    RAISE EXCEPTION
      'WhatsApp session still has auth state. Remote-unlink the linked device before deleting the session.'
      USING ERRCODE = '23503';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS protect_whatsapp_session_delete
  ON public.whatsapp_sessions;

CREATE TRIGGER protect_whatsapp_session_delete
BEFORE DELETE ON public.whatsapp_sessions
FOR EACH ROW
EXECUTE FUNCTION public.prevent_whatsapp_session_delete_with_auth();

COMMENT ON FUNCTION public.ridepicker_whatsapp_auth_clear_safe(uuid, text)
IS 'Bulk-clear Baileys auth only after a previously connected WhatsApp session is durably LOGGED_OUT.';
