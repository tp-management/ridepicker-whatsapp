-- Make the quiet-account stability window durable across process restarts.
-- A recovery connection that has remained continuously CONNECTED for five
-- minutes is considered a completed incident even if the Node timer that would
-- normally clear recovery metadata was lost in a Railway restart.

CREATE OR REPLACE FUNCTION public.register_whatsapp_unexpected_401(
  p_session_id uuid,
  p_reason_tag text DEFAULT NULL,
  p_conflict_type text DEFAULT NULL,
  p_terminal_candidate boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_attempt_count integer;
  v_recovery_state text;
  v_incident_started_at timestamptz;
  v_status text;
  v_connected_at timestamptz;
  v_retry_delay_ms integer := NULL;
  v_action text;
BEGIN
  SELECT
    recovery_attempt_count,
    recovery_state,
    recovery_incident_started_at,
    status,
    connected_at
  INTO
    v_attempt_count,
    v_recovery_state,
    v_incident_started_at,
    v_status,
    v_connected_at
  FROM public.whatsapp_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WhatsApp session not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_recovery_state = 'relink_required' THEN
    RETURN jsonb_build_object(
      'action', 'relink_required',
      'attemptCount', v_attempt_count,
      'retryDelayMs', NULL,
      'recoveryState', v_recovery_state,
      'incidentStartedAt', v_incident_started_at
    );
  END IF;

  -- Real notify traffic clears recovery eagerly through
  -- mark_whatsapp_recovery_stable(). For a quiet account, five continuous
  -- minutes in the same durable CONNECTED generation are strong evidence that
  -- the prior 401 incident recovered. This check happens in Postgres when the
  -- next 401 arrives, so a process restart cannot lose the stability proof.
  IF v_recovery_state = 'recovering'
     AND v_status = 'CONNECTED'
     AND v_connected_at IS NOT NULL
     AND v_now - v_connected_at >= interval '5 minutes'
  THEN
    v_recovery_state := 'idle';
    v_attempt_count := 0;
    v_incident_started_at := NULL;
  END IF;

  IF v_recovery_state <> 'recovering' OR v_incident_started_at IS NULL THEN
    v_attempt_count := 0;
    v_incident_started_at := v_now;
  END IF;

  v_attempt_count := v_attempt_count + 1;

  IF p_terminal_candidate THEN
    IF v_attempt_count = 1 THEN
      v_action := 'retry';
      v_recovery_state := 'recovering';
      v_retry_delay_ms := 2000;
    ELSE
      v_action := 'relink_required';
      v_recovery_state := 'relink_required';
    END IF;
  ELSE
    CASE v_attempt_count
      WHEN 1 THEN v_retry_delay_ms := 2000;
      WHEN 2 THEN v_retry_delay_ms := 10000;
      WHEN 3 THEN v_retry_delay_ms := 30000;
      ELSE v_retry_delay_ms := NULL;
    END CASE;

    IF v_retry_delay_ms IS NULL THEN
      v_action := 'relink_required';
      v_recovery_state := 'relink_required';
    ELSE
      v_action := 'retry';
      v_recovery_state := 'recovering';
    END IF;
  END IF;

  UPDATE public.whatsapp_sessions
  SET
    recovery_state = v_recovery_state,
    recovery_attempt_count = v_attempt_count,
    recovery_incident_started_at = v_incident_started_at,
    recovery_last_event_at = v_now,
    recovery_reason_tag = NULLIF(left(coalesce(p_reason_tag, ''), 80), ''),
    recovery_conflict_type = NULLIF(left(coalesce(p_conflict_type, ''), 80), ''),
    status = CASE
      WHEN v_recovery_state = 'relink_required' THEN 'ERROR'
      ELSE 'RECONNECTING'
    END
  WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'action', v_action,
    'attemptCount', v_attempt_count,
    'retryDelayMs', v_retry_delay_ms,
    'recoveryState', v_recovery_state,
    'incidentStartedAt', v_incident_started_at,
    'lastEventAt', v_now
  );
END;
$$;

REVOKE ALL ON FUNCTION public.register_whatsapp_unexpected_401(uuid, text, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_whatsapp_unexpected_401(uuid, text, text, boolean)
  TO service_role;
