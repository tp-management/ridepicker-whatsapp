-- Web Push subscriptions + transactional, durable delivery outbox.
-- Apply before deploying this branch; no production changes are made by the PR.
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

create table if not exists public.push_deliveries (
  id bigint generated always as identity primary key,
  alert_id bigint not null references public.big_money_alerts(id) on delete cascade,
  subscription_id bigint not null references public.push_subscriptions(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','sending','retry','delivered','skipped','dead')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by uuid,
  last_error text,
  last_http_status integer,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  unique(alert_id,subscription_id)
);
create index if not exists push_deliveries_due_idx
  on public.push_deliveries(next_attempt_at, id)
  where status in ('pending','retry','sending');
alter table public.push_deliveries enable row level security;
revoke all on table public.push_deliveries from public, anon, authenticated;
grant select, insert, update, delete on table public.push_deliveries to service_role;
grant usage, select on sequence public.push_deliveries_id_seq to service_role;

-- Atomic: a newly inserted alert and its push jobs commit together, or neither does.
create or replace function public.queue_big_money_push_deliveries()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  insert into public.push_deliveries(alert_id, subscription_id, user_id)
  select new.id, s.id, new.user_id
  from public.push_subscriptions s where s.user_id = new.user_id
  on conflict (alert_id, subscription_id) do nothing;
  return new;
end;
$$;
drop trigger if exists queue_big_money_push_on_insert on public.big_money_alerts;
create trigger queue_big_money_push_on_insert after insert on public.big_money_alerts
for each row execute function public.queue_big_money_push_deliveries();

-- Multiple app instances can claim jobs safely and reclaim crashed workers' leases.
create or replace function public.claim_pending_push_deliveries(
  p_worker_id uuid, p_batch_size integer default 10, p_lease_seconds integer default 30
) returns setof public.push_deliveries
language plpgsql security invoker set search_path = '' as $$
begin
  return query
  update public.push_deliveries d set
    status='sending', attempt_count=d.attempt_count+1,
    locked_at=now(), locked_by=p_worker_id
  where d.id in (
    select queued.id from public.push_deliveries queued
    where (
      queued.status in ('pending','retry') and queued.next_attempt_at <= now()
      or queued.status='sending' and queued.locked_at < now() - make_interval(secs => least(greatest(p_lease_seconds, 10), 120))
    )
    order by queued.next_attempt_at, queued.id
    for update skip locked
    limit least(greatest(p_batch_size,1),50)
  )
  returning d.*;
end;
$$;
revoke all on function public.claim_pending_push_deliveries(uuid,integer,integer) from public, anon, authenticated;
grant execute on function public.claim_pending_push_deliveries(uuid,integer,integer) to service_role;
