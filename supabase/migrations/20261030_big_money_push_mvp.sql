-- Minimal browser push registration. No SMS or delivery queue for the test rollout.
create table if not exists public.push_subscriptions (
  endpoint text primary key check (length(endpoint) <= 2048),
  user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions(user_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on public.push_subscriptions to service_role;
