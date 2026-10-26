CREATE TABLE IF NOT EXISTS public.activity_priorities (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  activity_key text NOT NULL,
  priority text NOT NULL DEFAULT 'regular',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, activity_key),
  CONSTRAINT activity_priorities_key_not_blank
    CHECK (length(btrim(activity_key)) > 0),
  CONSTRAINT activity_priorities_priority_check
    CHECK (priority IN ('regular', 'high'))
);

CREATE INDEX IF NOT EXISTS activity_priorities_user_updated_idx
  ON public.activity_priorities (user_id, updated_at DESC);

ALTER TABLE public.activity_priorities ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.activity_priorities FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.activity_priorities
  TO service_role;

COMMENT ON TABLE public.activity_priorities IS
  'Per-user Activity timeline priority overrides for both persisted activity rows and synthetic message entries.';
