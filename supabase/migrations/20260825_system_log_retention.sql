-- Keep high-volume diagnostics bounded without touching WhatsApp session/auth state.
-- Raw Baileys debug logs are useful for short-term transport diagnostics, so keep
-- seven days. All other system logs keep a longer 30-day investigation window.
-- The hourly batch cap avoids a large delete transaction if retention ever falls
-- behind for an extended period.

create extension if not exists pg_cron;

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
           source = 'baileys_raw'
           and level = 'debug'
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
