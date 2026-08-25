-- Make minimum-price filtering strict when a user has configured a price floor.
--
-- If minimum_job_price is active (> 0), a message must contain at least one
-- usable standalone numeric value after date/time/year/alphanumeric identifiers
-- are excluded. No usable number means the message is rejected before it enters
-- public.messages / n8n. If usable numbers exist, at least one must meet the
-- configured minimum.
--
-- Keyword and vehicle filters remain independent gates. This migration only
-- replaces the public.messages BEFORE INSERT filter function. It never mutates
-- whatsapp_sessions / whatsapp_auth and contains no logout or socket lifecycle code.

CREATE OR REPLACE FUNCTION public.filter_message_by_assist_keywords()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  keywords text[];
  keyword text;
  minimum_job_price numeric;
  assist_vehicle_types jsonb;
  normalized_body text;
  normalized_keyword text;
  keyword_matches boolean := false;
  scan_body text;
  number_match text[];
  number_value numeric;
  numeric_value_found boolean := false;
  price_matches boolean := false;
  vehicle_body text;
  recognized_vehicle boolean := false;
  selected_vehicle_matches boolean := false;
BEGIN
  SELECT
    COALESCE(dp.assist_keywords, '{}'::text[]),
    dp.minimum_job_price,
    COALESCE(dp.autopilot_rules -> 'assistVehicleTypes', '[]'::jsonb)
  INTO keywords, minimum_job_price, assist_vehicle_types
  FROM public.whatsapp_sessions ws
  LEFT JOIN public.driver_preferences dp
    ON dp.user_id = ws.user_id
  WHERE ws.id = NEW.session_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF jsonb_typeof(assist_vehicle_types) <> 'array' THEN
    assist_vehicle_types := '[]'::jsonb;
  END IF;

  -- Existing Assist keyword semantics remain unchanged and independent.
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

  -- Minimum-price filtering is strict when enabled. Numeric detection is not
  -- tied to £/GBP/fare/net/price wording.
  IF minimum_job_price IS NOT NULL AND minimum_job_price > 0 THEN
    scan_body := COALESCE(NEW.body, '');

    -- Remove obvious numeric date/time structures before generic number scanning.
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

    FOR number_match IN
      SELECT regexp_matches(
        scan_body,
        '(^|[^[:alnum:].])([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)(?=$|[^[:alnum:].])',
        'g'
      )
    LOOP
      number_value := replace(number_match[2], ',', '')::numeric;

      -- Ignore calendar years that survive unusual formatting.
      IF number_value = trunc(number_value)
         AND number_value BETWEEN 1900 AND 2100 THEN
        CONTINUE;
      END IF;

      numeric_value_found := true;

      IF number_value >= minimum_job_price THEN
        price_matches := true;
        EXIT;
      END IF;
    END LOOP;

    -- Strict policy: with an active minimum, missing/unknown price is not enough.
    IF NOT numeric_value_found THEN
      RETURN NULL;
    END IF;

    IF NOT price_matches THEN
      RETURN NULL;
    END IF;
  END IF;

  -- No selected vehicle types means the vehicle filter is disabled.
  IF jsonb_array_length(assist_vehicle_types) > 0 THEN
    vehicle_body := lower(
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

    -- Saloon
    IF vehicle_body ~ '\msaloon\M' THEN
      recognized_vehicle := true;
      IF assist_vehicle_types ? 'saloon' THEN
        selected_vehicle_matches := true;
      END IF;
    END IF;

    -- Estate
    IF vehicle_body ~ '\mestate\M' THEN
      recognized_vehicle := true;
      IF assist_vehicle_types ? 'estate' THEN
        selected_vehicle_matches := true;
      END IF;
    END IF;

    -- MPV, MPV6, MPV7, etc.
    IF vehicle_body ~ '\mmpv[0-9]*\M' THEN
      recognized_vehicle := true;
      IF assist_vehicle_types ? 'mpv' THEN
        selected_vehicle_matches := true;
      END IF;
    END IF;

    -- Treat 7/8/9-seater and minivan wording as the large/8-seater family.
    IF vehicle_body ~ '\m(?:7|8|9)(?:[[:space:]/-]+(?:7|8|9))*[[:space:]]*seaters?\M'
       OR vehicle_body ~ '\mmini[[:space:]-]*van\M' THEN
      recognized_vehicle := true;
      IF assist_vehicle_types ? '8_seater' THEN
        selected_vehicle_matches := true;
      END IF;
    END IF;

    IF recognized_vehicle AND NOT selected_vehicle_matches THEN
      RETURN NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.filter_message_by_assist_keywords()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.filter_message_by_assist_keywords()
  TO service_role;
