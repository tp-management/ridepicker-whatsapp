-- Activity is a user-facing timeline, not a transport trace.
-- Keep one row per semantic WhatsApp connected/disconnected transition while
-- leaving every technical socket/reconnect event in system_logs for diagnosis.

create or replace function public.ridepicker_activity_whatsapp_lifecycle_dedupe()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_previous_title text;
begin
  if new.type <> 'whatsapp'
     or new.title not in ('WhatsApp connected', 'WhatsApp disconnected') then
    return new;
  end if;

  -- Serialize lifecycle inserts per user so rolling deploys / overlapping
  -- sockets cannot race two identical Activity rows into the timeline.
  perform pg_advisory_xact_lock(
    hashtextextended('ridepicker:activity:whatsapp:' || new.user_id::text, 0)
  );

  select a.title
    into v_previous_title
  from public.activity a
  where a.user_id = new.user_id
    and a.type = 'whatsapp'
    and a.title in ('WhatsApp connected', 'WhatsApp disconnected')
  order by a.created_at desc, a.id desc
  limit 1;

  if v_previous_title = new.title then
    return null;
  end if;

  return new;
end;
$$;

revoke all on function public.ridepicker_activity_whatsapp_lifecycle_dedupe()
  from public, anon, authenticated;

-- Collapse historical runs of identical lifecycle state while preserving the
-- first event in each connected/disconnected episode.
with ordered as (
  select
    id,
    title,
    lag(title) over (
      partition by user_id
      order by created_at, id
    ) as previous_title
  from public.activity
  where type = 'whatsapp'
    and title in ('WhatsApp connected', 'WhatsApp disconnected')
), duplicates as (
  select id
  from ordered
  where title = previous_title
)
delete from public.activity a
using duplicates d
where a.id = d.id;

drop trigger if exists activity_whatsapp_lifecycle_dedupe
  on public.activity;

create trigger activity_whatsapp_lifecycle_dedupe
before insert on public.activity
for each row
execute function public.ridepicker_activity_whatsapp_lifecycle_dedupe();
