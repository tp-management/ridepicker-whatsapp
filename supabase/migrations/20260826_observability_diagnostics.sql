-- Structured observability support for RidePicker.
--
-- The application now stores high-signal lifecycle/request/auth events alongside
-- short-lived debug traces. Keep debug volume bounded, add a recent-event index,
-- and expose a service-role-only actionable view for incident triage.

create index if not exists system_logs_source_event_created_idx
  on public.system_logs (source, event, created_at desc);

create or replace view public.system_log_actionable_v1
with (security_invoker = true)
as
select
  id,
  user_id,
  session_id,
  level,
  source,
  event,
  message,
  details,
  coalesce(
    details ->> 'actionability',
    case
      when source = 'n8n' and event = 'n8n_failed' then 'expected'
      when level = 'error' then 'actionable'
      when level = 'warning' then 'attention'
      else 'diagnostic'
    end
  ) as actionability,
  created_at
from public.system_logs
where coalesce(
    details ->> 'actionability',
    case
      when source = 'n8n' and event = 'n8n_failed' then 'expected'
      when level = 'error' then 'actionable'
      when level = 'warning' then 'attention'
      else 'diagnostic'
    end
  ) in ('actionable', 'attention');

revoke all on public.system_log_actionable_v1
  from public, anon, authenticated;
grant select on public.system_log_actionable_v1
  to service_role;

do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid
    from cron.job
    where jobname = 'ridepicker-system-log-retention'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end
$$;

select cron.schedule(
  'ridepicker-system-log-retention',
  '17 * * * *',
  $retention$
    with doomed as (
      select id
      from public.system_logs
      where created_at < now() - interval '30 days'
         or (
           level = 'debug'
           and created_at < now() - interval '7 days'
         )
      order by created_at asc
      limit 5000
    )
    delete from public.system_logs as logs
    using doomed
    where logs.id = doomed.id;
  $retention$
);
