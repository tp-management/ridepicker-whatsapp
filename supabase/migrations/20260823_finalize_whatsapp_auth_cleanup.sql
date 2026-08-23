-- Finalize the WhatsApp auth lifecycle at the database boundary.
--
-- A healthy linked Baileys device can legitimately have hundreds of Signal
-- auth rows (including a large one-time pre-key pool). Those rows must remain
-- untouched while the device is active. Once the durable session becomes
-- LOGGED_OUT, however, all auth material for that session must disappear and
-- must not be recreated by late creds/key events.

CREATE OR REPLACE FUNCTION public.purge_whatsapp_auth_after_logged_out()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.whatsapp_auth
  WHERE session_id = NEW.id;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_whatsapp_auth_after_logged_out()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS purge_whatsapp_auth_after_logged_out
  ON public.whatsapp_sessions;

CREATE TRIGGER purge_whatsapp_auth_after_logged_out
AFTER UPDATE OF status ON public.whatsapp_sessions
FOR EACH ROW
WHEN (NEW.status = 'LOGGED_OUT')
EXECUTE FUNCTION public.purge_whatsapp_auth_after_logged_out();

CREATE OR REPLACE FUNCTION public.discard_whatsapp_auth_for_logged_out_session()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.whatsapp_sessions
    WHERE id = NEW.session_id
      AND status = 'LOGGED_OUT'
  ) THEN
    -- Late Baileys creds.update/key-store writes can race with socket shutdown.
    -- Once the durable session is LOGGED_OUT, silently discard those writes so
    -- auth cannot reappear after the purge trigger has run.
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.discard_whatsapp_auth_for_logged_out_session()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS discard_whatsapp_auth_for_logged_out_session
  ON public.whatsapp_auth;

CREATE TRIGGER discard_whatsapp_auth_for_logged_out_session
BEFORE INSERT OR UPDATE ON public.whatsapp_auth
FOR EACH ROW
EXECUTE FUNCTION public.discard_whatsapp_auth_for_logged_out_session();

-- Clean any residue left by older runtime versions that had already reached a
-- confirmed LOGGED_OUT state before this migration existed. Do not prune
-- CONNECTED/RECONNECTING/DISCONNECTED auth here: those credentials may still be
-- required to restore or remotely unlink the linked WhatsApp device.
DELETE FROM public.whatsapp_auth AS wa
USING public.whatsapp_sessions AS ws
WHERE ws.id = wa.session_id
  AND ws.status = 'LOGGED_OUT';

COMMENT ON FUNCTION public.purge_whatsapp_auth_after_logged_out()
IS 'Delete all Baileys auth rows only after the durable WhatsApp session is LOGGED_OUT.';

COMMENT ON FUNCTION public.discard_whatsapp_auth_for_logged_out_session()
IS 'Prevent late Baileys auth writes from recreating auth after a session is LOGGED_OUT.';
