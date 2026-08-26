-- Applied to RidePicker production on 2026-08-25.
-- Reconstructed from supabase_migrations.schema_migrations so the repository
-- contains the exact live DDL rather than a hand-written approximation.

CREATE TABLE IF NOT EXISTS public.assist_blocked_senders (
  session_id uuid NOT NULL REFERENCES public.whatsapp_sessions(id) ON DELETE CASCADE,
  sender_id text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, sender_id)
);

REVOKE ALL ON TABLE public.assist_blocked_senders FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.assist_blocked_senders TO service_role;

CREATE OR REPLACE FUNCTION public.drop_blocked_assist_sender_messages()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.sender_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.assist_blocked_senders b
       WHERE b.session_id = NEW.session_id
         AND b.sender_id = NEW.sender_id
     ) THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.drop_blocked_assist_sender_messages() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.drop_blocked_assist_sender_messages() TO service_role;

DROP TRIGGER IF EXISTS a_drop_blocked_assist_sender_messages ON public.messages;
CREATE TRIGGER a_drop_blocked_assist_sender_messages
BEFORE INSERT ON public.messages
FOR EACH ROW
EXECUTE FUNCTION public.drop_blocked_assist_sender_messages();
