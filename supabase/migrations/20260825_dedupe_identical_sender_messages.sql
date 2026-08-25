-- Drop repeated incoming text messages from the same sender before they enter
-- public.messages / n8n.
--
-- Existing uniqueness on (session_id, whatsapp_message_id) only catches replay of
-- the exact same WhatsApp message id. Spammers and cross-posters can generate a
-- fresh id for every copy, so this adds a content-level guard.
--
-- Dedupe identity:
--   same RidePicker session + same sender_id + same normalized text body
-- Dedupe window:
--   six hours across all chats/groups in that session
--
-- Six hours is intentionally bounded. It kills rapid cross-group reposts and
-- floods while allowing a genuinely identical job to be posted again later in
-- the day. Outgoing messages and media-bearing messages are not deduped here.
--
-- The advisory transaction lock serializes concurrent copies of the same
-- sender/body key, preventing a burst from racing the EXISTS check.
-- This migration only affects public.messages and never mutates WhatsApp auth or
-- session lifecycle state.

CREATE OR REPLACE FUNCTION public.normalize_message_dedupe_body(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT lower(
    btrim(
      regexp_replace(
        translate(
          normalize(COALESCE(input, ''), NFKC),
          chr(8203) || chr(8204) || chr(8205) || chr(65279),
          ''
        ),
        '[[:space:]]+',
        ' ',
        'g'
      )
    )
  );
$$;

CREATE INDEX IF NOT EXISTS messages_sender_recent_dedupe_idx
  ON public.messages (session_id, sender_id, created_at DESC)
  WHERE sender_id IS NOT NULL AND body IS NOT NULL;

CREATE OR REPLACE FUNCTION public.drop_recent_duplicate_sender_messages()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  normalized_body text;
  dedupe_lock_key bigint;
  dedupe_cutoff timestamptz;
BEGIN
  -- Preserve the user's own outgoing history and avoid treating two different
  -- media items with the same caption as duplicates.
  IF COALESCE(NEW.from_me, false)
     OR NEW.sender_id IS NULL
     OR COALESCE(NEW.has_media, false)
     OR COALESCE(NEW.body, '') = '' THEN
    RETURN NEW;
  END IF;

  normalized_body := public.normalize_message_dedupe_body(NEW.body);

  IF normalized_body = '' THEN
    RETURN NEW;
  END IF;

  dedupe_lock_key := hashtextextended(
    NEW.session_id::text || chr(31) || NEW.sender_id || chr(31) || normalized_body,
    0
  );

  PERFORM pg_advisory_xact_lock(dedupe_lock_key);

  dedupe_cutoff := clock_timestamp() - interval '6 hours';

  IF EXISTS (
    SELECT 1
    FROM public.messages existing
    WHERE existing.session_id = NEW.session_id
      AND existing.sender_id = NEW.sender_id
      AND NOT COALESCE(existing.from_me, false)
      AND NOT COALESCE(existing.has_media, false)
      AND existing.created_at >= dedupe_cutoff
      AND public.normalize_message_dedupe_body(existing.body) = normalized_body
    LIMIT 1
  ) THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS b_drop_recent_duplicate_sender_messages
  ON public.messages;
CREATE TRIGGER b_drop_recent_duplicate_sender_messages
BEFORE INSERT ON public.messages
FOR EACH ROW
EXECUTE FUNCTION public.drop_recent_duplicate_sender_messages();

REVOKE ALL ON FUNCTION public.normalize_message_dedupe_body(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_message_dedupe_body(text)
  TO service_role;

REVOKE ALL ON FUNCTION public.drop_recent_duplicate_sender_messages()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.drop_recent_duplicate_sender_messages()
  TO service_role;
