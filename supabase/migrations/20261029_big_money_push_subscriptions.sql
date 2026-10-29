-- Server-only push endpoints; do not expose subscription URLs in the Data API.
create table if not exists public.push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  endpoint text not null unique check (char_length(endpoint) <= 2048),
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_id_idx on public.push_subscriptions(user_id);
alter table public.push_subscriptions enable row level security;
revoke all on table public.push_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on table public.push_subscriptions to service_role;
grant usage, select on sequence public.push_subscriptions_id_seq to service_role;
