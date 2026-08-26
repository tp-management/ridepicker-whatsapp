-- Refine incident triage: native protocol errors are evidence to investigate,
-- not proof that RidePicker itself needs intervention. Application-level
-- lifecycle events determine whether a reconnect recovered or became actionable.

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
      when source in ('baileys_raw', 'whatsapp_raw') and level = 'error' then 'attention'
      when source in ('baileys_raw', 'whatsapp_raw') then 'diagnostic'
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
      when source in ('baileys_raw', 'whatsapp_raw') and level = 'error' then 'attention'
      when source in ('baileys_raw', 'whatsapp_raw') then 'diagnostic'
      when level = 'error' then 'actionable'
      when level = 'warning' then 'attention'
      else 'diagnostic'
    end
  ) in ('actionable', 'attention');

revoke all on public.system_log_actionable_v1
  from public, anon, authenticated;
grant select on public.system_log_actionable_v1
  to service_role;
