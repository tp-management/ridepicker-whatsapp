-- Assist message filtering is enforced before an incoming WhatsApp message can
-- enter the messages table. Returning NULL from this BEFORE INSERT trigger
-- makes PostgREST return no inserted row, and the backend therefore stops
-- before forwarding the message to n8n.

ALTER TABLE public.driver_preferences
  ADD COLUMN IF NOT EXISTS assist_keywords text[] NOT NULL DEFAULT '{}'::text[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'driver_preferences_assist_keywords_limit'
      AND conrelid = 'public.driver_preferences'::regclass
  ) THEN
    ALTER TABLE public.driver_preferences
      ADD CONSTRAINT driver_preferences_assist_keywords_limit
      CHECK (cardinality(assist_keywords) <= 50);
  END IF;
END;
$$;

COMMENT ON COLUMN public.driver_preferences.assist_keywords
IS 'Case-insensitive substring filters for incoming WhatsApp messages. Empty means process all messages.';

CREATE OR REPLACE FUNCTION public.filter_message_by_assist_keywords()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  keywords text[];
  keyword text;
  normalized_body text;
  normalized_keyword text;
BEGIN
  -- Outgoing messages remain available as conversation context. Assist keyword
  -- filtering controls inbound work discovery only.
  IF COALESCE(NEW.from_me, false) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(dp.assist_keywords, '{}'::text[])
  INTO keywords
  FROM public.whatsapp_sessions ws
  LEFT JOIN public.driver_preferences dp
    ON dp.user_id = ws.user_id
  WHERE ws.id = NEW.session_id;

  -- Missing preferences or an empty list means no keyword filter is active.
  IF NOT FOUND OR COALESCE(cardinality(keywords), 0) = 0 THEN
    RETURN NEW;
  END IF;

  -- Match semantics intentionally mirror the UI/backend:
  -- NFKC Unicode normalization, zero-width character removal, whitespace
  -- collapse, case-insensitive comparison, and plain substring matching.
  normalized_body := lower(
    btrim(
      regexp_replace(
        translate(
          normalize(COALESCE(NEW.body, ''), NFKC),
          chr(8203) || chr(8204) || chr(8205) || chr(65279),
          ''
        ),
        '[[:space:]]+',
        ' ',
        'g'
      )
    )
  );

  IF normalized_body = '' THEN
    RETURN NULL;
  END IF;

  FOREACH keyword IN ARRAY keywords LOOP
    normalized_keyword := lower(
      btrim(
        regexp_replace(
          translate(
            normalize(COALESCE(keyword, ''), NFKC),
            chr(8203) || chr(8204) || chr(8205) || chr(65279),
            ''
          ),
          '[[:space:]]+',
          ' ',
          'g'
        )
      )
    );

    IF normalized_keyword <> ''
       AND position(normalized_keyword IN normalized_body) > 0 THEN
      RETURN NEW;
    END IF;
  END LOOP;

  -- No configured keyword appeared anywhere in the normalized message body.
  -- Skipping the row also prevents n8n/AI processing because insertMessage()
  -- returns no inserted record to the runtime.
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS filter_assist_keywords_before_insert
  ON public.messages;

CREATE TRIGGER filter_assist_keywords_before_insert
BEFORE INSERT ON public.messages
FOR EACH ROW
EXECUTE FUNCTION public.filter_message_by_assist_keywords();

REVOKE ALL ON FUNCTION public.filter_message_by_assist_keywords()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.filter_message_by_assist_keywords()
  TO service_role;
