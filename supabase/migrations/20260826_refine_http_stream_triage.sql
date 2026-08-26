-- Normal SSE disconnects are expected client lifecycle, not incident attention.
-- Keep a second service-role-only view containing only rows that the backend
-- explicitly classified as actionable so incident triage has a clean queue.

create or replace view public.system_log_actionable_v1
with (security_invoker = true)
as
with classified as (
  select
    id,
    user_id,
    session_id,
    level,
    source,
    event,
    message,
    details,
    case
      when source = 'http'
        and event in ('http_request_aborted', 'http_stream_aborted', 'http_stream_closed')
        and coalesce(details ->> 'path', '') ~ '^/api/users/[^/]+/events/?$'
      then 'diagnostic'
      else coalesce(
        details ->> 'actionability',
        case
          when source = 'n8n' and event = 'n8n_failed' then 'expected'
          when source in ('baileys_raw', 'whatsapp_raw') and level = 'error' then 'attention'
          when source in ('baileys_raw', 'whatsapp_raw') then 'diagnostic'
          when level = 'error' then 'actionable'
          when level = 'warning' then 'attention'
          else 'diagnostic'
        end
      )
    end as actionability,
    created_at
  from public.system_logs
)
select *
from classified
where actionability in ('actionable', 'attention');

revoke all on public.system_log_actionable_v1
  from public, anon, authenticated;
grant select on public.system_log_actionable_v1
  to service_role;

create or replace view public.system_log_incidents_v1
with (security_invoker = true)
as
select *
from public.system_log_actionable_v1
where actionability = 'actionable';

revoke all on public.system_log_incidents_v1
  from public, anon, authenticated;
grant select on public.system_log_incidents_v1
  to service_role;
