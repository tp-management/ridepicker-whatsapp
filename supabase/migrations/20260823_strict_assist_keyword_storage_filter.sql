-- Assist keyword filtering is strict storage filtering.
-- When a keyword list is configured, only messages whose text contains at least
-- one keyword may enter public.messages, regardless of message direction.
-- Empty keyword lists continue to mean "store/process all messages".

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

  -- Strict invariant: unmatched messages never enter messages, regardless of
  -- whether Baileys marks them as incoming or from_me=true.
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.filter_message_by_assist_keywords()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.filter_message_by_assist_keywords()
  TO service_role;
