-- Make unexpected WhatsApp 401 recovery durable and non-destructive.
-- The runtime may retry saved registered credentials, but only an explicit
-- RidePicker logout is allowed to transition a session to LOGGED_OUT and
-- activate the existing auth purge trigger.

ALTER TABLE public.whatsapp_sessions
  ADD COLUMN IF NOT EXISTS recovery_state text NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS recovery_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recovery_incident_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS recovery_last_event_at timestamptz,
  ADD COLUMN IF NOT EXISTS recovery_reason_tag text,
  ADD COLUMN IF NOT EXISTS recovery_conflict_type text;

DO $$
BEGIN
  ALTER TABLE public.whatsapp_sessions
    ADD CONSTRAINT whatsapp_sessions_recovery_state_check
    CHECK (recovery_state IN ('idle', 'recovering', 'relink_required'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TABLE public.whatsapp_sessions
    ADD CONSTRAINT whatsapp_sessions_recovery_attempt_count_check
    CHECK (recovery_attempt_count >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

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
  v_retry_delay_ms integer := NULL;
  v_action text;
BEGIN
  SELECT
    recovery_attempt_count,
    recovery_state,
    recovery_incident_started_at
  INTO
    v_attempt_count,
    v_recovery_state,
    v_incident_started_at
  FROM public.whatsapp_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WhatsApp session not found'
      USING ERRCODE = 'P0002';
  END IF;

  -- Once a session is known to require an explicit relink, process restarts or
  -- duplicate close events must not create a fresh automatic retry budget.
  IF v_recovery_state = 'relink_required' THEN
    RETURN jsonb_build_object(
      'action', 'relink_required',
      'attemptCount', v_attempt_count,
      'retryDelayMs', NULL,
      'recoveryState', v_recovery_state,
      'incidentStartedAt', v_incident_started_at
    );
  END IF;

  IF v_recovery_state <> 'recovering' OR v_incident_started_at IS NULL THEN
    v_attempt_count := 0;
    v_incident_started_at := v_now;
  END IF;

  v_attempt_count := v_attempt_count + 1;

  -- conflict/device_removed is ambiguous in current Baileys/WhatsApp builds:
  -- it can be a real remote unlink or a false-positive protocol conflict.
  -- Give it exactly one non-destructive confirmation reconnect. If the same
  -- incident produces another terminal candidate, stop and require relinking.
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
    -- Unknown/other 401s receive a small bounded recovery budget. This budget
    -- is durable in Postgres, so container restarts cannot reset it.
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
    -- Never transition to LOGGED_OUT here. That state is reserved for an
    -- explicit RidePicker-requested remote logout that has completed.
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

CREATE OR REPLACE FUNCTION public.mark_whatsapp_recovery_stable(
  p_session_id uuid,
  p_connected_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE public.whatsapp_sessions
  SET
    recovery_state = 'idle',
    recovery_attempt_count = 0,
    recovery_incident_started_at = NULL,
    recovery_last_event_at = NULL,
    recovery_reason_tag = NULL,
    recovery_conflict_type = NULL
  WHERE id = p_session_id
    AND status = 'CONNECTED'
    AND connected_at = p_connected_at
    AND recovery_state <> 'idle';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- A relink-required session may still contain registered credentials that the
-- normal auth clear guard intentionally protects. Only an explicit new pairing
-- flow may call this narrower RPC. It waits behind the auth-store mutation queue
-- in Node, then atomically removes the obsolete auth and resets durable link
-- metadata so a fresh pairing can start without a late-write resurrection.
CREATE OR REPLACE FUNCTION public.ridepicker_whatsapp_auth_prepare_relink(
  p_session_id uuid,
  p_auth_type text DEFAULT 'baileys_supabase_v1'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
  v_recovery_state text;
BEGIN
  SELECT status, recovery_state
  INTO v_status, v_recovery_state
  FROM public.whatsapp_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WhatsApp session not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_status <> 'ERROR' OR v_recovery_state <> 'relink_required' THEN
    RAISE EXCEPTION 'WhatsApp session is not approved for explicit relink cleanup'
      USING ERRCODE = '55000';
  END IF;

  DELETE FROM public.whatsapp_auth
  WHERE session_id = p_session_id
    AND auth_type = p_auth_type;

  UPDATE public.whatsapp_sessions
  SET
    status = 'DISCONNECTED',
    whatsapp_phone = NULL,
    display_name = NULL,
    connected_at = NULL,
    recovery_state = 'idle',
    recovery_attempt_count = 0,
    recovery_incident_started_at = NULL,
    recovery_last_event_at = NULL,
    recovery_reason_tag = NULL,
    recovery_conflict_type = NULL
  WHERE id = p_session_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.register_whatsapp_unexpected_401(uuid, text, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_whatsapp_unexpected_401(uuid, text, text, boolean)
  TO service_role;

REVOKE ALL ON FUNCTION public.mark_whatsapp_recovery_stable(uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_whatsapp_recovery_stable(uuid, timestamptz)
  TO service_role;

REVOKE ALL ON FUNCTION public.ridepicker_whatsapp_auth_prepare_relink(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ridepicker_whatsapp_auth_prepare_relink(uuid, text)
  TO service_role;
