-- BIG MONEY: 10 total Web Push attempts spaced 30 seconds apart.
-- The 10th notification is followed by a 30-second response window, then ignored.
-- Historical rows are excluded from automatic reminders to avoid surprise alerts.
ALTER TABLE public.big_money_alerts
  DROP CONSTRAINT IF EXISTS big_money_alerts_status_check;
ALTER TABLE public.big_money_alerts
  ADD CONSTRAINT big_money_alerts_status_check
  CHECK (status IN ('pending', 'accepted', 'declined', 'ignored'));

ALTER TABLE public.big_money_alerts
  ADD COLUMN IF NOT EXISTS push_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE public.big_money_alerts
  ADD COLUMN IF NOT EXISTS next_push_at timestamptz DEFAULT now();

ALTER TABLE public.big_money_alerts
  DROP CONSTRAINT IF EXISTS big_money_alerts_push_attempts_check;
ALTER TABLE public.big_money_alerts
  ADD CONSTRAINT big_money_alerts_push_attempts_check
  CHECK (push_attempts BETWEEN 0 AND 10);

-- Existing pending jobs retain their original status; only new inserts enter
-- the reminder schedule. Run before deploying the new worker.
UPDATE public.big_money_alerts SET next_push_at = NULL;

CREATE INDEX IF NOT EXISTS big_money_due_push_idx
  ON public.big_money_alerts (next_push_at, id)
  WHERE status = 'pending' AND next_push_at IS NOT NULL;

-- A single atomic claim is shared by the insert webhook and the background
-- worker. SKIP LOCKED prevents two Railway replicas from sending duplicates.
CREATE OR REPLACE FUNCTION public.claim_big_money_push_actions(
  p_batch_size integer DEFAULT 25,
  p_alert_id bigint DEFAULT NULL
)
RETURNS TABLE (
  alert_id bigint,
  user_id uuid,
  action text,
  attempt_number integer
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH due AS MATERIALIZED (
    SELECT a.id
    FROM public.big_money_alerts AS a
    WHERE a.status = 'pending'
      AND a.next_push_at IS NOT NULL
      AND a.next_push_at <= now()
      AND (p_alert_id IS NULL OR a.id = p_alert_id)
    ORDER BY a.next_push_at ASC, a.id ASC
    LIMIT LEAST(GREATEST(COALESCE(p_batch_size, 25), 1), 100)
    FOR UPDATE OF a SKIP LOCKED
  ), claimed AS (
    UPDATE public.big_money_alerts AS a
    SET status = CASE WHEN a.push_attempts >= 10 THEN 'ignored' ELSE 'pending' END,
        decided_at = CASE WHEN a.push_attempts >= 10 THEN now() ELSE a.decided_at END,
        push_attempts = CASE WHEN a.push_attempts >= 10 THEN 10 ELSE a.push_attempts + 1 END,
        next_push_at = CASE WHEN a.push_attempts >= 10 THEN NULL ELSE now() + interval '30 seconds' END
    FROM due
    WHERE a.id = due.id AND a.status = 'pending'
    RETURNING a.id, a.user_id, a.status, a.push_attempts
  )
  SELECT c.id AS alert_id, c.user_id,
         CASE WHEN c.status = 'ignored' THEN 'ignored' ELSE 'send' END AS action,
         c.push_attempts AS attempt_number
  FROM claimed AS c;
$$;

REVOKE ALL ON FUNCTION public.claim_big_money_push_actions(integer, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_big_money_push_actions(integer, bigint)
  TO service_role;
COMMENT ON FUNCTION public.claim_big_money_push_actions(integer, bigint) IS
  'Service-role only. Atomically claims due BIG MONEY notifications and expires jobs after 10 sends + 30s.';

NOTIFY pgrst, 'reload schema';
