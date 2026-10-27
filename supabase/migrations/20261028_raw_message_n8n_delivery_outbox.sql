-- V1 RAW inbox + transactional outbox, staged for an explicitly coordinated rollout.
-- Incoming eligible messages are inserted with n8n_delivery_status='pending'
-- in the SAME message INSERT. No separate enqueue write or crash window.
-- Historic messages are not replayed by default.
--
-- IMPORTANT: apply this schema before deploying its matching Node worker;
-- do not deploy the worker until the n8n endpoint accepts message_id idempotently.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS n8n_delivery_status text,
  ADD COLUMN IF NOT EXISTS n8n_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS n8n_last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS n8n_next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS n8n_last_error text,
  ADD COLUMN IF NOT EXISTS n8n_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS n8n_locked_by text;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_n8n_delivery_status_check
  CHECK (n8n_delivery_status IS NULL OR n8n_delivery_status IN
    ('pending','delivering','delivered','retry','dead'));

ALTER TABLE public.messages
  ADD CONSTRAINT messages_n8n_attempt_count_check CHECK (n8n_attempt_count >= 0);

-- Only historically ACKed deliveries are marked delivered. Null means a
-- pre-outbox row or an ineligible message; it must NEVER be backfilled as
-- pending, otherwise old history would flood the new AI workflow.
UPDATE public.messages SET n8n_delivery_status = 'delivered'
WHERE forwarded_to_n8n_at IS NOT NULL AND n8n_delivery_status IS NULL;

-- AI state is independent of transport state. Legacy states remain accepted
-- temporarily for compatibility with the old runtime during a rolling release.
UPDATE public.messages SET processing_status = 'new'
WHERE processing_status = 'sent_to_ai';
UPDATE public.messages SET processing_status = 'failed'
WHERE processing_status = 'error';
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_processing_status_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_processing_status_check
CHECK (processing_status IN
  ('new','processing','parsed','ignored','failed','sent_to_ai','error'));

-- Never discard permitted RAW events merely because keyword, numeric price,
-- vehicle recognition, or six-hour same-body heuristics disagree.
-- Preserve the OFF/history validation and blocked-sender gates.
DROP TRIGGER IF EXISTS filter_assist_keywords_before_insert ON public.messages;
DROP TRIGGER IF EXISTS b_drop_recent_duplicate_sender_messages ON public.messages;

CREATE INDEX IF NOT EXISTS messages_n8n_delivery_due_idx
ON public.messages (n8n_next_attempt_at, id)
WHERE n8n_delivery_status IN ('pending','retry');

CREATE INDEX IF NOT EXISTS messages_n8n_delivery_lease_idx
ON public.messages (n8n_locked_at, id)
WHERE n8n_delivery_status = 'delivering';

-- Atomic claim across multiple application replicas. The lease also permits
-- recovery after a worker crash. Only the server's service_role may call it.
CREATE OR REPLACE FUNCTION public.claim_pending_n8n_messages(
  p_worker_id text, p_batch_size integer DEFAULT 5, p_lease_seconds integer DEFAULT 60
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_worker_id IS NULL OR length(btrim(p_worker_id)) < 1 OR length(p_worker_id) > 128
    OR p_batch_size NOT BETWEEN 1 AND 50
    OR p_lease_seconds NOT BETWEEN 30 AND 600 THEN
    RAISE EXCEPTION 'invalid n8n worker claim parameters';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT m.id
    FROM public.messages m
    JOIN public.whatsapp_sessions ws ON ws.id = m.session_id
    WHERE (
      (m.n8n_delivery_status IN ('pending','retry')
        AND (m.n8n_next_attempt_at IS NULL OR m.n8n_next_attempt_at <= now()))
      OR (m.n8n_delivery_status = 'delivering'
        AND m.n8n_locked_at < now() - make_interval(secs => p_lease_seconds))
    )
    -- Do not begin processing queued offers while tracking is off or from
    -- before the latest enable time.
    AND ws.bot_mode <> 'off'
    AND (ws.bot_enabled_at IS NULL OR m.message_timestamp >= ws.bot_enabled_at)
    ORDER BY m.id
    LIMIT p_batch_size
    FOR UPDATE OF m SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.messages m
    SET n8n_delivery_status = 'delivering',
        n8n_attempt_count = m.n8n_attempt_count + 1,
        n8n_last_attempt_at = now(),
        n8n_next_attempt_at = NULL,
        n8n_locked_at = now(),
        n8n_locked_by = p_worker_id
    FROM candidates c
    WHERE m.id = c.id
    RETURNING m.id, m.session_id, m.whatsapp_message_id, m.chat_id,
      m.chat_name, m.sender_id, m.sender_name, m.body,
      m.message_timestamp, m.n8n_attempt_count
  )
  SELECT jsonb_build_object(
    'id', c.id::text,
    'user_id', ws.user_id,
    'session_id', c.session_id,
    'whatsapp_message_id', c.whatsapp_message_id,
    'chat_id', c.chat_id,
    'chat_name', c.chat_name,
    'sender_id', c.sender_id,
    'sender_name', c.sender_name,
    'body', c.body,
    'message_timestamp', c.message_timestamp,
    'n8n_attempt_count', c.n8n_attempt_count
  )
  FROM claimed c JOIN public.whatsapp_sessions ws ON ws.id = c.session_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_pending_n8n_messages(text,integer,integer)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pending_n8n_messages(text,integer,integer)
TO service_role;

COMMENT ON COLUMN public.messages.n8n_delivery_status IS
  'Nullable transport state (NULL = not queued); independent of AI processing_status';
