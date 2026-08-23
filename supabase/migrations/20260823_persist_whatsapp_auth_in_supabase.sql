-- Persist Baileys credentials and Signal keys in Supabase only.
-- Auth payloads are encrypted with a key stored in Supabase Vault.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM vault.secrets
    WHERE name = 'ridepicker_whatsapp_auth_v1'
  ) THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'ridepicker_whatsapp_auth_v1',
      'RidePicker Baileys auth-state encryption key'
    );
  END IF;
END
$$;

ALTER TABLE public.whatsapp_auth
  ALTER COLUMN auth_type SET DEFAULT 'baileys_supabase_v1';

ALTER TABLE public.whatsapp_auth
  DROP CONSTRAINT IF EXISTS whatsapp_auth_session_id_fkey;

ALTER TABLE public.whatsapp_auth
  ADD CONSTRAINT whatsapp_auth_session_id_fkey
  FOREIGN KEY (session_id)
  REFERENCES public.whatsapp_sessions(id)
  ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.ridepicker_whatsapp_auth_read(
  p_session_id uuid,
  p_auth_type text,
  p_auth_keys text[] DEFAULT NULL
)
RETURNS TABLE(auth_key text, payload text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions, pg_temp
AS $$
DECLARE
  encryption_key text;
BEGIN
  SELECT decrypted_secret
  INTO encryption_key
  FROM vault.decrypted_secrets
  WHERE name = 'ridepicker_whatsapp_auth_v1'
  ORDER BY created_at DESC
  LIMIT 1;

  IF encryption_key IS NULL THEN
    RAISE EXCEPTION 'WhatsApp auth encryption key is unavailable';
  END IF;

  RETURN QUERY
  SELECT
    wa.auth_key,
    extensions.pgp_sym_decrypt(
      decode(wa.encrypted_payload, 'base64'),
      encryption_key
    ) AS payload
  FROM public.whatsapp_auth AS wa
  WHERE wa.session_id = p_session_id
    AND wa.auth_type = p_auth_type
    AND (p_auth_keys IS NULL OR wa.auth_key = ANY(p_auth_keys));
END;
$$;

CREATE OR REPLACE FUNCTION public.ridepicker_whatsapp_auth_write(
  p_session_id uuid,
  p_auth_type text,
  p_entries jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions, pg_temp
AS $$
DECLARE
  encryption_key text;
  entry jsonb;
  entry_key text;
  entry_payload text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_sessions WHERE id = p_session_id
  ) THEN
    RAISE EXCEPTION 'WhatsApp session does not exist'
      USING ERRCODE = '23503';
  END IF;

  IF p_auth_type IS NULL OR btrim(p_auth_type) = '' THEN
    RAISE EXCEPTION 'auth type is required'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(p_entries) <> 'array' THEN
    RAISE EXCEPTION 'auth entries must be a JSON array'
      USING ERRCODE = '22023';
  END IF;

  SELECT decrypted_secret
  INTO encryption_key
  FROM vault.decrypted_secrets
  WHERE name = 'ridepicker_whatsapp_auth_v1'
  ORDER BY created_at DESC
  LIMIT 1;

  IF encryption_key IS NULL THEN
    RAISE EXCEPTION 'WhatsApp auth encryption key is unavailable';
  END IF;

  FOR entry IN SELECT value FROM jsonb_array_elements(p_entries)
  LOOP
    entry_key := entry ->> 'auth_key';

    IF entry_key IS NULL OR entry_key = '' THEN
      RAISE EXCEPTION 'auth_key is required'
        USING ERRCODE = '22023';
    END IF;

    IF NOT (entry ? 'payload') OR entry -> 'payload' = 'null'::jsonb THEN
      DELETE FROM public.whatsapp_auth
      WHERE session_id = p_session_id
        AND auth_type = p_auth_type
        AND auth_key = entry_key;
    ELSE
      entry_payload := entry ->> 'payload';

      INSERT INTO public.whatsapp_auth (
        session_id,
        auth_type,
        auth_key,
        encrypted_payload
      )
      VALUES (
        p_session_id,
        p_auth_type,
        entry_key,
        encode(
          extensions.pgp_sym_encrypt(
            entry_payload,
            encryption_key,
            'cipher-algo=aes256,compress-algo=0'
          ),
          'base64'
        )
      )
      ON CONFLICT (session_id, auth_type, auth_key)
      DO UPDATE SET
        encrypted_payload = EXCLUDED.encrypted_payload,
        updated_at = now();
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.ridepicker_whatsapp_auth_clear(
  p_session_id uuid,
  p_auth_type text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  DELETE FROM public.whatsapp_auth
  WHERE session_id = p_session_id
    AND (p_auth_type IS NULL OR auth_type = p_auth_type);
$$;

REVOKE ALL ON FUNCTION public.ridepicker_whatsapp_auth_read(uuid, text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ridepicker_whatsapp_auth_write(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ridepicker_whatsapp_auth_clear(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ridepicker_whatsapp_auth_read(uuid, text, text[]) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.ridepicker_whatsapp_auth_write(uuid, text, jsonb) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.ridepicker_whatsapp_auth_clear(uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ridepicker_whatsapp_auth_read(uuid, text, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.ridepicker_whatsapp_auth_write(uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.ridepicker_whatsapp_auth_clear(uuid, text) TO service_role;
