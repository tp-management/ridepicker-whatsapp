-- BIG MONEY popup inbox. Deploy with API ownership checks before enabling for customers.
CREATE TABLE IF NOT EXISTS public.big_money_alerts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  source_message_id bigint REFERENCES public.messages(id) ON DELETE SET NULL,
  original_message text NOT NULL CHECK (length(btrim(original_message)) > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CONSTRAINT big_money_source_unique UNIQUE (user_id, source_message_id)
);
CREATE INDEX IF NOT EXISTS big_money_pending_per_user
  ON public.big_money_alerts (user_id, created_at ASC)
  WHERE status = 'pending';
ALTER TABLE public.big_money_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.big_money_alerts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.big_money_alerts TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.big_money_alerts_id_seq TO service_role;
COMMENT ON TABLE public.big_money_alerts IS 'Server-managed BIG MONEY modal queue; preserve original message and decision history.';
