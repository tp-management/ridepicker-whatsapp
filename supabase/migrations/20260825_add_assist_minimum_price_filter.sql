-- Extend the existing Assist storage filter with the driver's minimum job price.
--
-- Semantics are deliberately conservative:
--   * keyword filtering keeps its existing strict behavior;
--   * when minimum_job_price is NULL/0, price filtering is disabled;
--   * explicit GBP prices support £120, GBP 120, 120 GBP, £1,250.50, etc.;
--   * if multiple explicit GBP prices exist, any amount at/above the minimum passes;
--   * messages with no explicit GBP price continue through Assist so we do not
--     accidentally discard valid jobs whose price is omitted or phrased indirectly.
--
-- This only replaces the BEFORE INSERT filter function used by public.messages.
-- It does not update whatsapp_sessions, whatsapp_auth, credentials or socket state.

COMMENT ON COLUMN public.driver_preferences.minimum_job_price
IS 'Minimum explicit GBP job price for Assist. NULL or 0 disables price filtering. Messages with no explicit GBP price remain eligible for processing.';

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
  price_match text[];
  price_value numeric;
  explicit_price_found boolean := false;
BEGIN
  SELECT
    COALESCE(dp.assist_keywords, '{}'::text[]),
    dp.minimum_job_price
  INTO keywords, minimum_job_price
  FROM public.whatsapp_sessions ws
  LEFT JOIN public.driver_preferences dp
    ON dp.user_id = ws.user_id
  WHERE ws.id = NEW.session_id;

  -- A missing session/preferences row means there is no Assist preference to
  -- enforce. Preserve the existing fail-open behavior for that case.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Existing keyword semantics stay unchanged: an empty list means every
  -- message is eligible, otherwise at least one normalized substring must match.
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

  -- NULL/0 means the price preference is not active.
  IF minimum_job_price IS NULL OR minimum_job_price <= 0 THEN
    RETURN NEW;
  END IF;

  -- Currency before amount: £120, £ 120, GBP120, GBP 120, £1,250.50.
  FOR price_match IN
    SELECT regexp_matches(
      COALESCE(NEW.body, ''),
      '(?:£|GBP)[[:space:]]*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)',
      'gi'
    )
  LOOP
    explicit_price_found := true;
    price_value := replace(price_match[1], ',', '')::numeric;

    IF price_value >= minimum_job_price THEN
      RETURN NEW;
    END IF;
  END LOOP;

  -- Currency after amount: 120£, 120 GBP, 1,250.50 GBP.
  FOR price_match IN
    SELECT regexp_matches(
      COALESCE(NEW.body, ''),
      '([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)[[:space:]]*(?:£|GBP)',
      'gi'
    )
  LOOP
    explicit_price_found := true;
    price_value := replace(price_match[1], ',', '')::numeric;

    IF price_value >= minimum_job_price THEN
      RETURN NEW;
    END IF;
  END LOOP;

  -- We only reject when the message explicitly states GBP amount(s) and every
  -- one is below the configured minimum. Unknown/missing prices still reach AI.
  IF explicit_price_found THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.filter_message_by_assist_keywords()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.filter_message_by_assist_keywords()
  TO service_role;
