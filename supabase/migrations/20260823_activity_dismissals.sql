-- Activity timeline entries can come from two sources:
-- 1) rows in public.activity;
-- 2) synthesized message entries from public.messages.
--
-- Deleting a message-derived timeline item must not destroy the underlying
-- WhatsApp message, because that message can still be linked to jobs or used as
-- conversation context. This table stores durable per-user timeline tombstones
-- for those synthetic entries.

CREATE TABLE IF NOT EXISTS public.activity_dismissals (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  activity_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, activity_key),
  CONSTRAINT activity_dismissals_key_not_blank
    CHECK (length(btrim(activity_key)) > 0)
);

COMMENT ON TABLE public.activity_dismissals IS
  'Per-user tombstones for synthetic Activity timeline entries. Source data is preserved.';

ALTER TABLE public.activity_dismissals ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.activity_dismissals FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.activity_dismissals TO service_role;

CREATE INDEX IF NOT EXISTS activity_dismissals_user_created_idx
  ON public.activity_dismissals (user_id, created_at DESC);
