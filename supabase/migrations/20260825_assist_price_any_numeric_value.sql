-- Relax Assist minimum-price detection so it is not tied to currency/price words.
--
-- Price filtering now scans the message for standalone numeric values after
-- removing obvious date/time structures. This lets formats such as:
--   PRICE 110 NET
--   FARE: 80 GROSS
--   Net: 75
--   130 Pounds
--   £90 / GBP 90
-- all use the same numeric comparison without requiring any price keyword.
--
-- Existing Assist keyword filtering remains a separate, independent filter.
-- This migration only replaces the BEFORE INSERT function used by messages and
-- does not mutate WhatsApp session/auth state or touch socket lifecycle code.

COMMENT ON COLUMN public.driver_preferences.minimum_job_price
IS 'Minimum numeric job price for Assist. NULL or 0 disables price filtering. Numeric price detection is not tied to currency or price keywords.';

CREATE OR REPLACE FUNCTION public.filter_message_by_assist_keywords()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  keywords text[];
  keyword text;
  minimum_job_price numeric;
  normalized_body text;
  normalized_keyword text;
  keyword_matches boolean := false;
  scan_body text;
  number_match text[];
  number_value numeric;
  numeric_value_found boolean := false;
BEGIN
  SELECT
    COALESCE(dp.assist_keywords, '{}'::text[]),
    dp.minimum_job_price
  INTO keywords, minimum_job_price
  FROM public.whatsapp_sessions ws
  LEFT JOIN public.driver_preferences dp
    ON dp.user_id = ws.user_id
  WHERE ws.id = NEW.session_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Keyword filtering is independent from price detection and keeps the
  -- existing strict normalized substring behavior.
  IF COALESCE(cardinality(keywords), 0) > 0 THEN
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
        keyword_matches := true;
        EXIT;
      END IF;
    END LOOP;

    IF NOT keyword_matches THEN
      RETURN NULL;
    END IF;
  END IF;

  IF minimum_job_price IS NULL OR minimum_job_price <= 0 THEN
    RETURN NEW;
  END IF;

  scan_body := COALESCE(NEW.body, '');

  -- Strip obvious numeric date/time structures before generic number scanning.
  -- This prevents a year such as 2026 or a pickup time such as 09:25 from
  -- accidentally satisfying a £80 minimum.
  scan_body := regexp_replace(
    scan_body,
    '[0-9]{1,2}[/-][0-9]{1,2}(?:[/-][0-9]{2,4})?',
    ' ',
    'g'
  );
  scan_body := regexp_replace(
    scan_body,
    '[0-2]?[0-9]:[0-5][0-9]',
    ' ',
    'g'
  );
  scan_body := regexp_replace(
    scan_body,
    '\m(?:19|20)[0-9]{2}\M',
    ' ',
    'g'
  );
  scan_body := regexp_replace(
    scan_body,
    '\m[0-3]?[0-9](?:st|nd|rd|th)?[[:space:]]+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\M',
    ' ',
    'gi'
  );

  -- Scan every remaining standalone number. Letters touching a number keep it
  -- out of the candidate set, so postcodes/flight numbers such as W8, T3,
  -- BA120 and CB24 are not treated as prices. No fare/net/GBP/£ keyword is
  -- required for a number to qualify.
  FOR number_match IN
    SELECT regexp_matches(
      scan_body,
      '(^|[^[:alnum:].])([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)(?=$|[^[:alnum:].])',
      'g'
    )
  LOOP
    number_value := replace(number_match[2], ',', '')::numeric;

    -- Four-digit calendar years that survive unusual formatting are ignored.
    IF number_value = trunc(number_value)
       AND number_value BETWEEN 1900 AND 2100 THEN
      CONTINUE;
    END IF;

    numeric_value_found := true;

    IF number_value >= minimum_job_price THEN
      RETURN NEW;
    END IF;
  END LOOP;

  -- If at least one candidate number exists and none reaches the minimum,
  -- reject the message before it enters messages/n8n. If there is no usable
  -- numeric candidate at all, preserve the previous fail-open behavior.
  IF numeric_value_found THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.filter_message_by_assist_keywords()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.filter_message_by_assist_keywords()
  TO service_role;
