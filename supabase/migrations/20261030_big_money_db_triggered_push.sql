-- A new row in big_money_alerts triggers Push from ANY authorized writer.
-- Before applying, set the same strong random secret in:
--   Railway: BIG_MONEY_WEBHOOK_SECRET
--   Supabase Vault: ridepicker_big_money_webhook_secret
-- Example (run privately in Supabase SQL Editor, never commit a real key):
--   select vault.create_secret('YOUR_RANDOM_KEY', 'ridepicker_big_money_webhook_secret');
create extension if not exists pg_net with schema extensions;
create schema if not exists private;

create or replace function private.ridepicker_big_money_webhook()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  webhook_secret text;
begin
  select decrypted_secret into webhook_secret
  from vault.decrypted_secrets
  where name = 'ridepicker_big_money_webhook_secret'
  limit 1;

  if webhook_secret is null or length(webhook_secret) < 20 then
    raise warning 'RidePicker BIG MONEY webhook secret is not configured';
    return new;
  end if;

  perform net.http_post(
    url := 'https://ridepicker-whatsapp-production.up.railway.app/internal/big-money-inserted',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-ridepicker-webhook-key', webhook_secret
    ),
    body := jsonb_build_object(
      'type', 'INSERT',
      'schema', 'public',
      'table', 'big_money_alerts',
      'record', jsonb_build_object('id', new.id, 'user_id', new.user_id)
    ),
    timeout_milliseconds := 5000
  );
  return new;
end;
$$;

revoke all on function private.ridepicker_big_money_webhook() from public, anon, authenticated;

drop trigger if exists ridepicker_big_money_after_insert on public.big_money_alerts;
create trigger ridepicker_big_money_after_insert
after insert on public.big_money_alerts
for each row when (new.status = 'pending')
execute function private.ridepicker_big_money_webhook();
